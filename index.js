const express = require('express');
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require("mongodb");

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("❌ MONGO_URI is not set. Set it in environment variables.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db, groupsCollection;

async function connectDB() {
  try {
    await client.connect();
    db = client.db("cfTrackerBot"); // your database name
    groupsCollection = db.collection("groups");
    console.log("✅ Connected to MongoDB!");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    throw err;
  }
}

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN is not set. Set it in environment variables.");
  process.exit(1);
}


const bot = new TelegramBot(TOKEN, { webHook: true });

// Build webhook URL: prefer explicit WEBHOOK_URL env; otherwise try RENDER_EXTERNAL_URL
const explicitWebhook = `https://your-service.onrender.com/webhook/${TOKEN}`; // e.g. https://your-service.onrender.com/webhook/<TOKEN>
const renderUrl = process.env.RENDER_EXTERNAL_URL; // provided by Render for the service
const WEBHOOK_URL = explicitWebhook || (renderUrl ? `${renderUrl.replace(/\/$/, "")}/webhook/${TOKEN}` : null);

if (!WEBHOOK_URL) {
  console.error("❌ WEBHOOK_URL not set and RENDER_EXTERNAL_URL not available. Set WEBHOOK_URL env to https://<your-domain>/webhook/<TOKEN>");
  process.exit(1);
}

// Telegram webhook handler route
app.post(`/webhook/${TOKEN}`, (req, res) => {
  try {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error processing update:", err);
    res.sendStatus(500);
  }
});

// Optional test route (Render health checks)
app.get("/", (req, res) => {
  res.send("🤖 Telegram bot is alive on Render!");
});

async function getTodaySolvedCount(handle) {
  // Use axios for compatibility in Node
  const res = await axios.get(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}`);
  const data = res.data;

  if (data.status !== "OK") throw new Error("Invalid handle or API error");

  const submissions = data.result;
  const startOfToday = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

  const solved = new Set();

  for (const sub of submissions) {
    if (sub.verdict === "OK" && sub.creationTimeSeconds >= startOfToday) {
      const problemId = `${sub.problem.contestId}-${sub.problem.index}`;
      solved.add(problemId);
    }
  }

  return solved.size;
}

let botUsername = "@CpTrackBuddybot";

async function start() {
  try {
    // Connect DB first
    await connectDB();

    // Start server
    const PORT = process.env.PORT || 10000;
    const server = app.listen(PORT, async () => {
      console.log(`Bot server running on port ${PORT}`);
      console.log(`Registering webhook at ${WEBHOOK_URL} ...`);

      // Get bot username
      try {
        const me = await bot.getMe();
        if (me && me.username) {
          botUsername = `@${me.username}`;
          console.log("Bot username:", botUsername);
        }
      } catch (err) {
        console.warn("Could not get bot username:", err.message);
      }

      // Register webhook with Telegram
      try {
        // pass drop_pending_updates: true to ignore old updates (optional)
        await bot.setWebHook(WEBHOOK_URL, { drop_pending_updates: true });
        console.log("✅ Webhook registered with Telegram.");
      } catch (err) {
        console.error("❌ Failed to set webhook:", err.response ? err.response.data : err.message);
      }
    });

    // Message handler
    bot.on("message", async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text || "";

      // If group chat, ignore messages that don't mention the bot
      if (msg.chat.type !== "private" && !text.includes(botUsername)) return;

      const cleanedText = text.replace(new RegExp(botUsername, "gi"), "").trim();

      // Handle /add command
      if (cleanedText.startsWith("/add")) {
        const handle = cleanedText.split(" ")[1];
        if (!handle) {
          return bot.sendMessage(chatId, "❌ Please provide a Codeforces handle. Example: `/add tourist`", { parse_mode: "Markdown" });
        }

        try {
          const existing = groupsCollection && await groupsCollection.findOne({ groupId: chatId });
          if (!existing) {
            await groupsCollection.insertOne({
              groupId: chatId,
              groupName: msg.chat.title,
              users: [{ handle }],
            });
            console.log(`✅ New group added: ${msg.chat.title}`);
            await bot.sendMessage(chatId, `✅ Added ${handle} and created new tracking for this group.`);
          } else {
            const already = existing.users.find(u => u.handle === handle);
            if (already) {
              return bot.sendMessage(chatId, `⚠️ ${handle} is already being tracked.`);
            }

            existing.users.push({ handle });
            await groupsCollection.updateOne(
              { groupId: chatId },
              { $set: { users: existing.users } }
            );

            await bot.sendMessage(chatId, `✅ Added ${handle} to tracking list.`);
          }
        } catch (err) {
          console.error("Error adding group/user:", err);
          await bot.sendMessage(chatId, "❌ Something went wrong while adding the handle.");
        }

        return;
      }

      // Otherwise, report today's solved counts for tracked users
      try {
        const grpdata = groupsCollection && await groupsCollection.findOne({ groupId: chatId });
        if (grpdata && grpdata.users && grpdata.users.length > 0) {
          for (const u of grpdata.users) {
            try {
              const solve = await getTodaySolvedCount(u.handle);
              await bot.sendMessage(chatId, `📝 ${u.handle} solved ${solve} problems today.`);
            } catch (innerErr) {
              console.error(`Error fetching for ${u.handle}:`, innerErr.message);
              await bot.sendMessage(chatId, `❌ Could not fetch data for ${u.handle}.`);
            }
          }
        } else {
          await bot.sendMessage(chatId, "No users are being tracked in this group. Use /add <handle> to add someone.");
        }
      } catch (err) {
        console.error("Error fetching solved count:", err.message);
        await bot.sendMessage(chatId, "❌ Could not fetch Codeforces data. Make sure the handles are correct.");
      }

      console.log("User said:", chatId, cleanedText);
    });

  } catch (err) {
    console.error("Fatal error on startup:", err);
    process.exit(1);
  }
}

start();