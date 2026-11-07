import app from "./app.js";

// Local development entry point. On Vercel the API is imported from
// api/index.js and exposed as a serverless function instead, so this file
// only runs when the server is started directly (npm run dev / npm start).
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Studio Space Server is running on port ${PORT}`);
});
