import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const PORT = process.env.PORT || 5000;
const app = express();

app.use(cors());
app.use(express.json());

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
        app.post("/studios", async (req, res) => {
            try {
                const studioData = req.body;

                if (!studioData.title || !studioData.ownerEmail) {
                    return res.status(400).send({
                        success: false,
                        message: "Required fields missing.",
                    });
                }

                const newStudio = {
                    ...studioData,
                    hourlyRate: parseFloat(studioData.hourlyRate),
                    securityDeposit: parseFloat(
                        studioData.securityDeposit || 0,
                    ),
                    maxCapacity: parseInt(studioData.maxCapacity, 10),
                    rating: studioData.rating || 0,
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
        app.put("/studios/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Studio ID format",
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
        app.delete("/studios/:id", async (req, res) => {
            try {
                const id = req.params.id;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({
                        success: false,
                        message: "Invalid Studio ID format",
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
        app.post("/bookings", async (req, res) => {
            try {
                const bookingData = req.body;

                const newBooking = {
                    studioId: bookingData.studioId,
                    studioTitle: bookingData.studioTitle,
                    imageUrl: bookingData.imageUrl,
                    userEmail: bookingData.userEmail,
                    userName: bookingData.userName,
                    hostEmail: bookingData.hostEmail,
                    bookingDate: bookingData.bookingDate,
                    totalPrice: parseFloat(bookingData.totalPrice),
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
        app.patch("/bookings/:id", async (req, res) => {
            try {
                const id = req.params.id;
                const { status } = req.body;

                if (!ObjectId.isValid(id)) {
                    return res
                        .status(400)
                        .send({
                            success: false,
                            message: "Invalid Booking ID",
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
