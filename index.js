import express from "express";
import cors from "cors";
import crypto from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const PORT = process.env.PORT || 5000;
const app = express();

// Credentialed CORS: cookies are scoped by host (not port), so the browser on
// localhost:3000 may send its HTTPOnly session cookie to localhost:5000 — but
// only when the origin is echoed explicitly and credentials are allowed.
const CLIENT_ORIGINS = (
    process.env.CLIENT_ORIGINS ??
    "http://localhost:3000,http://localhost:3001,http://127.0.0.1:3000"
)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Challenge 1 — JWT verification for HTTPOnly-cookie protected mutations.
//
// The Next.js app mints a BetterAuth JWT (EdDSA, signed with a key from its
// JWKS) and stores it in the HTTPOnly cookie `studiospace_token`. Because the
// cookie is HttpOnly, client-side JS can never read or tamper with it; this
// server verifies the signature against the public JWKS and rejects anything
// missing, malformed, tampered with or expired with 401 Unauthorized.
// ---------------------------------------------------------------------------
const API_TOKEN_COOKIE = "studiospace_token";
const JWKS_URL =
    process.env.AUTH_JWKS_URL || "http://localhost:3000/api/auth/jwks";

/** kid -> crypto.KeyObject, refreshed whenever an unknown kid shows up. */
const signingKeys = new Map();

function decodePart(part) {
    return Buffer.from(part, "base64url");
}

async function resolveSigningKey(kid) {
    const cached = signingKeys.get(kid);
    if (cached) return cached;

    const response = await fetch(JWKS_URL, {
        headers: { accept: "application/json" },
    });
    if (!response.ok) {
        throw new Error(`JWKS unavailable (${response.status})`);
    }
    const { keys } = await response.json();
    for (const jwk of keys ?? []) {
        signingKeys.set(
            jwk.kid,
            crypto.createPublicKey({ key: jwk, format: "jwk" }),
        );
    }
    const key = signingKeys.get(kid);
    if (!key) throw new Error("Unknown signing key");
    return key;
}

async function verifyApiToken(token) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed token");

    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(decodePart(headerPart).toString("utf8"));
    const key = await resolveSigningKey(header.kid);

    const signed = Buffer.from(`${headerPart}.${payloadPart}`);
    const signature = decodePart(signaturePart);
    const valid =
        header.alg === "EdDSA"
            ? crypto.verify(null, signed, key, signature)
            : header.alg === "RS256"
              ? crypto.verify("sha256", signed, key, signature)
              : false;
    if (!valid) throw new Error("Bad signature");

    const payload = JSON.parse(decodePart(payloadPart).toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
        throw new Error("Token expired");
    }
    if (!payload.email) throw new Error("Token carries no identity claim");
    return payload;
}

function readCookie(header, name) {
    if (!header) return undefined;
    for (const pair of header.split(";")) {
        const index = pair.indexOf("=");
        if (index === -1) continue;
        if (pair.slice(0, index).trim() === name) {
            return decodeURIComponent(pair.slice(index + 1).trim());
        }
    }
    return undefined;
}

/** Express middleware: 401 Unauthorized unless a valid JWT cookie is present. */
async function requireAuth(req, res, next) {
    try {
        const token = readCookie(req.headers.cookie, API_TOKEN_COOKIE);
        if (!token) {
            return res
                .status(401)
                .send({ success: false, message: "Unauthorized" });
        }
        req.auth = await verifyApiToken(token);
        next();
    } catch {
        return res
            .status(401)
            .send({ success: false, message: "Unauthorized" });
    }
}

// ---------------------------------------------------------------------------
// Challenge 2 — double-booking prevention helpers.
//
// A reservation is the window [startsAt, endsAt). Two windows on the SAME
// studio collide when `existing.startsAt < new.endsAt` and
// `existing.endsAt > new.startsAt` — open intervals, so back-to-back slots
// (14:00–16:00 then 16:00–18:00) are allowed while any overlap is rejected.
// Only "Confirmed" reservations hold a room, per the requirement.
// ---------------------------------------------------------------------------
const HOUR_MS = 60 * 60 * 1000;

/** Builds a booking window from "YYYY-MM-DDTHH:MM" + duration (default 1h). */
function parseBookingWindow(bookingDate, durationHours) {
    const startsAt = new Date(bookingDate);
    if (Number.isNaN(startsAt.getTime())) return null;
    const hours = Math.min(Math.max(parseInt(durationHours, 10) || 1, 1), 24);
    return {
        startsAt,
        endsAt: new Date(startsAt.getTime() + hours * HOUR_MS),
        hours,
    };
}

/** Human-readable slot for error messages, e.g. "10:00–14:00 on 2027-05-10". */
function formatSlot({ startsAt, endsAt }) {
    const pad = (value) => String(value).padStart(2, "0");
    const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const day = `${startsAt.getFullYear()}-${pad(startsAt.getMonth() + 1)}-${pad(startsAt.getDate())}`;
    return `${clock(startsAt)}–${clock(endsAt)} on ${day}`;
}

const client = new MongoClient(process.env.MONGO_URI);

async function run() {
    try {
        await client.connect();
        console.log("Connected to MongoDB successfully!");

        const db = client.db("studio-space");
        const studiosCollection = db.collection("studios");
        const bookingsCollection = db.collection("bookings");

        // 1. STUDIO ROUTES

        // POST: Create a new Studio Listing (/add-studio context)
        // Challenge 1: rejected with 401 unless a valid JWT cookie is sent.
        app.post("/studios", requireAuth, async (req, res) => {
            try {
                const studioData = req.body ?? {};

                if (!studioData.title) {
                    return res.status(400).send({
                        success: false,
                        message: "Required fields missing.",
                    });
                }

                // Explicit whitelist: nothing from the body can spoof identity
                // or internal fields. Ownership comes from the verified JWT.
                const newStudio = {
                    title: String(studioData.title),
                    category: String(studioData.category ?? "Workshop"),
                    hourlyRate: parseFloat(studioData.hourlyRate) || 0,
                    securityDeposit:
                        parseFloat(studioData.securityDeposit) || 0,
                    maxCapacity: parseInt(studioData.maxCapacity, 10) || 1,
                    location: String(studioData.location ?? ""),
                    imageUrl: String(studioData.imageUrl ?? ""),
                    amenities: Array.isArray(studioData.amenities)
                        ? studioData.amenities.map(String)
                        : [],
                    overview: String(studioData.overview ?? ""),
                    ownerEmail: req.auth.email,
                    ownerName: req.auth.name ?? "",
                    rating: 0,
                    createdAt: new Date(),
                };

                const result = await studiosCollection.insertOne(newStudio);
                res.status(201).send({
                    success: true,
                    insertedId: result.insertedId,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // GET: Retrieve all studios (Supports filtering by ownerEmail or search query)
        app.get("/studios", async (req, res) => {
            try {
                const { ownerEmail, category } = req.query;
                let query = {};

                if (ownerEmail) {
                    query.ownerEmail = ownerEmail;
                }

                if (category) {
                    query.category = category;
                }

                const studios = await studiosCollection.find(query).toArray();
                res.send(studios);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // GET: Single studio details by ID (/studios/[id])
        app.get("/studios/:id", async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Studio ID format",
                    });
                }

                const studio = await studiosCollection.findOne({
                    _id: new ObjectId(id),
                });
                if (!studio) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Studio not found" });
                }

                res.send(studio);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // PUT: Update studio listing (/studios/edit/[id])
        // Challenge 1: requires a valid JWT, and only the listing's owner may edit.
        app.put("/studios/:id", requireAuth, async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Studio ID format",
                    });
                }

                const existing = await studiosCollection.findOne({
                    _id: new ObjectId(id),
                });
                if (!existing) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Listing not found" });
                }
                if (existing.ownerEmail !== req.auth.email) {
                    return res.status(403).send({
                        success: false,
                        message: "You can only edit your own listings.",
                    });
                }

                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        title: updatedData.title,
                        category: updatedData.category,
                        hourlyRate: parseFloat(updatedData.hourlyRate),
                        securityDeposit: parseFloat(
                            updatedData.securityDeposit || 0,
                        ),
                        maxCapacity: parseInt(updatedData.maxCapacity, 10),
                        location: updatedData.location,
                        imageUrl: updatedData.imageUrl,
                        amenities: updatedData.amenities,
                        overview: updatedData.overview,
                        updatedAt: new Date(),
                    },
                };

                const result = await studiosCollection.updateOne(
                    filter,
                    updateDoc,
                );
                if (result.matchedCount === 0) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Listing not found" });
                }

                res.send({
                    success: true,
                    modifiedCount: result.modifiedCount,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // DELETE: Remove studio listing (/my-listings context)
        // Challenge 1: requires a valid JWT, and only the listing's owner may delete.
        app.delete("/studios/:id", requireAuth, async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Studio ID format",
                    });
                }

                const existing = await studiosCollection.findOne({
                    _id: new ObjectId(id),
                });
                if (!existing) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Listing not found" });
                }
                if (existing.ownerEmail !== req.auth.email) {
                    return res.status(403).send({
                        success: false,
                        message: "You can only delete your own listings.",
                    });
                }

                const result = await studiosCollection.deleteOne({
                    _id: new ObjectId(id),
                });
                if (result.deletedCount === 0) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Listing not found" });
                }

                res.send({ success: true, deletedCount: result.deletedCount });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // 2. BOOKING ROUTES

        // POST: Reserve a studio slot
        // Challenge 1: requires a valid JWT; the guest identity is taken from
        // the token so a caller can never impersonate another user.
        // Challenge 2: the requested window is verified against existing
        // "Confirmed" reservations before it is saved; overlapping requests
        // are rejected with 409 and a clear message.
        app.post("/bookings", requireAuth, async (req, res) => {
            try {
                const bookingData = req.body ?? {};

                if (!bookingData.studioId || !bookingData.bookingDate) {
                    return res.status(400).send({
                        success: false,
                        message: "Required fields missing.",
                    });
                }

                const window = parseBookingWindow(
                    bookingData.bookingDate,
                    bookingData.durationHours,
                );
                if (!window) {
                    return res.status(400).send({
                        success: false,
                        message: "That date and time doesn't look right.",
                    });
                }
                if (window.startsAt.getTime() < Date.now()) {
                    return res.status(400).send({
                        success: false,
                        message: "Pick a start time in the future.",
                    });
                }

                const studioId = String(bookingData.studioId);
                const day = String(bookingData.bookingDate).slice(0, 10);

                // (a) Normalized bookings: MongoDB does the interval math with
                //     range operators — start before my end AND end after my start.
                const confirmed = await bookingsCollection.findOne({
                    studioId,
                    status: "Confirmed",
                    $and: [
                        { startsAt: { $lt: window.endsAt } },
                        { endsAt: { $gt: window.startsAt } },
                    ],
                });

                // (b) Legacy bookings only store the `bookingDate` string, so
                //     narrow to that day with $gte/$lt and finish the interval
                //     comparison in code.
                let conflictWindow = null;
                if (confirmed) {
                    conflictWindow = {
                        startsAt: confirmed.startsAt,
                        endsAt: confirmed.endsAt,
                    };
                } else {
                    const legacy = await bookingsCollection
                        .find({
                            studioId,
                            status: "Confirmed",
                            startsAt: { $exists: false },
                            bookingDate: {
                                $gte: `${day}T00:00`,
                                $lt: `${day}T24:00`,
                            },
                        })
                        .toArray();

                    for (const booking of legacy) {
                        const legacyWindow = parseBookingWindow(
                            booking.bookingDate,
                            booking.durationHours,
                        );
                        if (!legacyWindow) continue;
                        if (
                            legacyWindow.startsAt < window.endsAt &&
                            legacyWindow.endsAt > window.startsAt
                        ) {
                            conflictWindow = legacyWindow;
                            break;
                        }
                    }
                }

                if (conflictWindow) {
                    const studioLabel =
                        String(bookingData.studioTitle || "").trim() ||
                        "This studio";
                    return res.status(409).send({
                        success: false,
                        message: `That slot is already taken — ${studioLabel} has a confirmed booking from ${formatSlot(conflictWindow)}. Choose another time.`,
                    });
                }

                const newBooking = {
                    studioId,
                    studioTitle: String(bookingData.studioTitle ?? ""),
                    imageUrl: String(bookingData.imageUrl ?? ""),
                    hostEmail: String(bookingData.hostEmail ?? ""),
                    userEmail: req.auth.email,
                    userName: req.auth.name ?? "",
                    bookingDate: String(bookingData.bookingDate),
                    durationHours: window.hours,
                    startsAt: window.startsAt,
                    endsAt: window.endsAt,
                    totalPrice: parseFloat(bookingData.totalPrice) || 0,
                    status: "Pending", // Pending, Confirmed, Completed, Cancelled
                    createdAt: new Date(),
                };

                const result = await bookingsCollection.insertOne(newBooking);
                res.status(201).send({
                    success: true,
                    insertedId: result.insertedId,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // GET: User specific bookings (/my-bookings)
        app.get("/bookings", async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).send({
                        success: false,
                        message: "Email query param required",
                    });
                }

                const bookings = await bookingsCollection
                    .find({ userEmail: email })
                    .toArray();
                res.send(bookings);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });

        // PATCH: Cancel/Update booking status
        // Challenge 1: requires a valid JWT; only the guest who booked or the
        // studio's host may change a reservation's status.
        app.patch("/bookings/:id", requireAuth, async (req, res) => {
            try {
                const id = req.params.id;
                const { status } = req.body ?? {};

                if (!ObjectId.isValid(id)) {
                    return res
                        .status(400)
                        .send({
                            success: false,
                            message: "Invalid Booking ID",
                        });
                }

                const allowedStatuses = [
                    "Pending",
                    "Confirmed",
                    "Completed",
                    "Cancelled",
                ];
                if (!allowedStatuses.includes(status)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid booking status",
                    });
                }

                const booking = await bookingsCollection.findOne({
                    _id: new ObjectId(id),
                });
                if (!booking) {
                    return res
                        .status(404)
                        .send({ success: false, message: "Booking not found" });
                }
                const caller = req.auth.email;
                if (
                    booking.userEmail !== caller &&
                    booking.hostEmail !== caller
                ) {
                    return res.status(403).send({
                        success: false,
                        message: "You can only update your own reservations.",
                    });
                }

                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: { status: status },
                };

                const result = await bookingsCollection.updateOne(
                    filter,
                    updateDoc,
                );
                res.send({
                    success: true,
                    modifiedCount: result.modifiedCount,
                });
            } catch (error) {
                res.status(500).send({
                    success: false,
                    message: error.message,
                });
            }
        });
        
    } catch (error) {
        console.error("Database connection error:", error);
    }
}

run().catch(console.dir);

app.get("/", (req, res) => {
    res.send("Studio Space Server is working");
});

app.listen(PORT, () => {
    console.log(`Studio Space Server is running on port ${PORT}`);
});
