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
