require("dotenv").config();

const dns = require("dns");
dns.setServers(["1.1.1.1", "8.8.8.8"]);

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
} = require("discord.js");

const mongoose = require("mongoose");
const { GoogleGenAI } = require("@google/genai");

// ============================================================
// CONFIG
// ============================================================

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;
const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const MEMORY_LIMIT = 15;
const LONG_TERM_MEMORY_LIMIT = 30;

// ============================================================
// SPAM CONFIG
// ============================================================

const SPAM_WINDOW = 5000; // 5 seconds
const SPAM_WARNING_LIMIT = 5;
const SPAM_TIMEOUT_LIMIT = 7;

const FIRST_TIMEOUT = 60 * 1000; // 1 minute
const REPEAT_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const TIMEOUT_HISTORY = 30 * 60 * 1000; // 30 minutes

const spamTracker = new Map();
const spamWarnings = new Map();
const spamTimeouts = new Map();

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,

    // Needed for finding server members by name.
    GatewayIntentBits.GuildMembers,
  ],
});

// ============================================================
// GEMINI
// ============================================================

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
});

// ============================================================
// MONGODB SCHEMAS
// ============================================================

const conversationSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },

    username: {
      type: String,
      required: true,
    },

    role: {
      type: String,
      enum: ["user", "nova"],
      required: true,
    },

    message: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const Conversation = mongoose.model(
  "Conversation",
  conversationSchema,
  "conversations"
);

const memorySchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },

    username: {
      type: String,
      required: true,
    },

    memory: {
      type: String,
      required: true,
    },

    category: {
      type: String,
      required: true,
    },

    importance: {
      type: Number,
      default: 5,
    },

    expiresAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Memory = mongoose.model(
  "Memory",
  memorySchema,
  "memories"
);

// ============================================================
// MEMORY SETTINGS
// ============================================================

const VALID_MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "personal",
  "interest",
  "relationship",
  "goal",
  "important",
];

const VALID_MEMORY_ACTIONS = [
  "save",
  "update",
  "delete",
  "none",
];

// ============================================================
// MONGODB CONNECTION
// ============================================================

async function connectMongoDB() {
  try {
    await mongoose.connect(MONGO_URI);

    console.log("✅ Connected to MongoDB Atlas");

    if (mongoose.connection.host) {
      console.log(
        `🖥️ Host: ${mongoose.connection.host}`
      );
    }

    if (mongoose.connection.name) {
      console.log(
        `📁 Database: ${mongoose.connection.name}`
      );
    }
  } catch (error) {
    console.error(
      "❌ MongoDB connection failed:",
      error.message
    );

    process.exit(1);
  }
}

// ============================================================
// CONVERSATION MEMORY
// ============================================================

async function saveConversation(
  userId,
  username,
  role,
  message
) {
  try {
    await Conversation.create({
      userId,
      username,
      role,
      message,
    });

    const count = await Conversation.countDocuments({
      userId,
    });

    if (count > MEMORY_LIMIT) {
      const oldMessages =
        await Conversation.find({ userId })
          .sort({ createdAt: 1 })
          .limit(count - MEMORY_LIMIT);

      const ids = oldMessages.map(
        (item) => item._id
      );

      if (ids.length > 0) {
        await Conversation.deleteMany({
          _id: { $in: ids },
        });
      }
    }

    console.log(
      `💾 ${role === "user" ? "User" : "Nova"} message saved`
    );
  } catch (error) {
    console.error(
      "❌ Failed to save conversation:",
      error.message
    );
  }
}

async function loadRecentConversation(userId) {
  try {
    const messages =
      await Conversation.find({ userId })
        .sort({ createdAt: -1 })
        .limit(MEMORY_LIMIT)
        .lean();

    messages.reverse();

    console.log(
      `🧠 Loaded ${messages.length} recent messages`
    );

    return messages;
  } catch (error) {
    console.error(
      "❌ Failed to load conversation:",
      error.message
    );

    return [];
  }
}

// ============================================================
// INDIA DATE HELPERS
// ============================================================

function getIndiaNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "Asia/Kolkata",
    })
  );
}

function endOfDay(date) {
  const result = new Date(date);

  result.setHours(23, 59, 59, 999);

  return result;
}

// ============================================================
// TEMPORARY MEMORY DATE DETECTION
// ============================================================

function detectTemporaryDate(text) {
  const lower = text.toLowerCase();
  const now = getIndiaNow();

  if (
    /\b(tomorrow|tmr|tmrw)\b/.test(lower)
  ) {
    const date = new Date(now);

    date.setDate(date.getDate() + 1);

    return endOfDay(date);
  }

  if (/\btoday\b/.test(lower)) {
    return endOfDay(now);
  }

  const daysMatch =
    lower.match(
      /\bin\s+(\d+)\s+days?\b/
    );

  if (daysMatch) {
    const days =
      parseInt(daysMatch[1], 10);

    const date = new Date(now);

    date.setDate(date.getDate() + days);

    return endOfDay(date);
  }

  const weeksMatch =
    lower.match(
      /\bin\s+(\d+)\s+weeks?\b/
    );

  if (weeksMatch) {
    const weeks =
      parseInt(weeksMatch[1], 10);

    const date = new Date(now);

    date.setDate(
      date.getDate() + weeks * 7
    );

    return endOfDay(date);
  }

  if (/\bthis week\b/.test(lower)) {
    const date = new Date(now);

    const day = date.getDay();

    const daysUntilSunday =
      day === 0 ? 0 : 7 - day;

    date.setDate(
      date.getDate() + daysUntilSunday
    );

    return endOfDay(date);
  }

  if (/\bnext week\b/.test(lower)) {
    const date = new Date(now);

    const day = date.getDay();

    const daysUntilMonday =
      day === 0 ? 1 : 8 - day;

    date.setDate(
      date.getDate() + daysUntilMonday + 6
    );

    return endOfDay(date);
  }

  if (/\bthis weekend\b/.test(lower)) {
    const date = new Date(now);

    const day = date.getDay();

    const daysUntilSaturday =
      day <= 6 ? 6 - day : 0;

    date.setDate(
      date.getDate() + daysUntilSaturday + 1
    );

    return endOfDay(date);
  }

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];

  for (let i = 0; i < weekdays.length; i++) {
    const weekday =
      weekdays[i];

    if (
      new RegExp(
        `\\bnext ${weekday}\\b`
      ).test(lower)
    ) {
      const currentDay =
        now.getDay();

      let difference =
        (i - currentDay + 7) % 7;

      if (difference === 0) {
        difference = 7;
      }

      const date = new Date(now);

      date.setDate(
        date.getDate() + difference
      );

      return endOfDay(date);
    }
  }

  return null;
}

function looksTemporary(text) {
  const lower = text.toLowerCase();

  const temporaryWords = [
    "exam",
    "exams",
    "test",
    "assignment",
    "deadline",
    "meeting",
    "appointment",
    "interview",
    "trip",
    "flight",
    "event",
    "tomorrow",
    "tmr",
    "tmrw",
    "today",
    "this week",
    "next week",
    "this weekend",
  ];

  return temporaryWords.some(
    (word) =>
      lower.includes(word)
  );
}

// ============================================================
// EXPIRED MEMORY CLEANUP
// ============================================================

async function cleanupExpiredMemories() {
  try {
    const result =
      await Memory.deleteMany({
        expiresAt: {
          $ne: null,
          $lte: new Date(),
        },
      });

    if (result.deletedCount > 0) {
      console.log(
        `🧹 Removed ${result.deletedCount} expired memories`
      );
    }
  } catch (error) {
    console.error(
      "❌ Failed to clean expired memories:",
      error.message
    );
  }
}

// ============================================================
// LONG-TERM MEMORY
// ============================================================

async function loadLongTermMemories(userId) {
  try {
    await cleanupExpiredMemories();

    const memories =
      await Memory.find({
        userId,

        $or: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              $gt: new Date(),
            },
          },
        ],
      })
        .sort({
          importance: -1,
          updatedAt: -1,
        })
        .limit(LONG_TERM_MEMORY_LIMIT)
        .lean();

    console.log(
      `🧠 Loaded ${memories.length} long-term memories`
    );

    return memories;
  } catch (error) {
    console.error(
      "❌ Failed to load long-term memories:",
      error.message
    );

    return [];
  }
}

// ============================================================
// MEMORY SIMILARITY
// ============================================================

function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(
      /[^a-z0-9\s]/g,
      ""
    )
    .split(/\s+/)
    .filter(
      (word) =>
        word.length >= 3
    );
}

function findRelatedMemory(
  memories,
  text
) {
  const newWords =
    new Set(
      normalizeWords(text)
    );

  let bestMemory = null;
  let bestScore = 0;

  for (const memory of memories) {
    const memoryWords =
      normalizeWords(
        memory.memory
      );

    let score = 0;

    for (const word of memoryWords) {
      if (newWords.has(word)) {
        score++;
      }
    }

    if (
      score >= 2 &&
      score > bestScore
    ) {
      bestScore = score;
      bestMemory = memory;
    }
  }

  return bestMemory;
}

// ============================================================
// MEMORY EXPIRATION
// ============================================================

function determineExpiration(
  memoryText,
  requestedExpiration
) {
  if (
    requestedExpiration &&
    requestedExpiration !== "relative"
  ) {
    const date =
      new Date(requestedExpiration);

    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  if (
    requestedExpiration ===
    "relative"
  ) {
    const detected =
      detectTemporaryDate(
        memoryText
      );

    if (detected) {
      return detected;
    }

    const fallback =
      new Date();

    fallback.setDate(
      fallback.getDate() + 7
    );

    return fallback;
  }

  if (
    looksTemporary(memoryText)
  ) {
    const detected =
      detectTemporaryDate(
        memoryText
      );

    if (detected) {
      return detected;
    }

    const fallback =
      new Date();

    fallback.setDate(
      fallback.getDate() + 7
    );

    return fallback;
  }

  return null;
}

// ============================================================
// SAVE MEMORY
// ============================================================

async function saveMemory({
  userId,
  username,
  memoryText,
  category,
  importance,
  expiresAt,
}) {
  try {
    if (!memoryText) {
      return;
    }

    if (
      !VALID_MEMORY_CATEGORIES.includes(
        category
      )
    ) {
      return;
    }

    const existing =
      await Memory.find({
        userId,
      }).lean();

    const related =
      findRelatedMemory(
        existing,
        memoryText
      );

    if (related) {
      console.log(
        "🧠 Similar memory already exists. Skipping duplicate."
      );

      return;
    }

    const temporary =
      looksTemporary(memoryText);

    let finalExpiration =
      determineExpiration(
        memoryText,
        expiresAt
      );

    if (
      temporary &&
      !finalExpiration
    ) {
      finalExpiration =
        new Date();

      finalExpiration.setDate(
        finalExpiration.getDate() + 7
      );
    }

    let finalImportance =
      Number(importance) || 5;

    finalImportance =
      Math.max(
        1,
        Math.min(
          10,
          finalImportance
        )
      );

    const newMemory =
      await Memory.create({
        userId,
        username,
        memory: memoryText,
        category,
        importance:
          finalImportance,
        expiresAt:
          finalExpiration,
      });

    console.log(
      "🧠 New long-term memory saved"
    );

    console.log(
      `   ${newMemory.memory}`
    );

    console.log(
      `   Category: ${newMemory.category}`
    );

    console.log(
      `   Importance: ${newMemory.importance}`
    );

    console.log(
      `   ${
        newMemory.expiresAt
          ? `Expires: ${newMemory.expiresAt.toLocaleString()}`
          : "Permanent"
      }`
    );
  } catch (error) {
    console.error(
      "❌ Failed to save long-term memory:",
      error.message
    );
  }
}

// ============================================================
// UPDATE MEMORY
// ============================================================

async function updateMemory({
  userId,
  username,
  memoryText,
  category,
  importance,
  expiresAt,
}) {
  try {
    const memories =
      await Memory.find({
        userId,
      }).lean();

    const related =
      findRelatedMemory(
        memories,
        memoryText
      );

    if (!related) {
      await saveMemory({
        userId,
        username,
        memoryText,
        category,
        importance,
        expiresAt,
      });

      return;
    }

    const finalExpiration =
      determineExpiration(
        memoryText,
        expiresAt
      );

    await Memory.findByIdAndUpdate(
      related._id,
      {
        memory: memoryText,
        category:
          VALID_MEMORY_CATEGORIES.includes(
            category
          )
            ? category
            : related.category,
        importance:
          Number(importance) || 5,
        expiresAt:
          finalExpiration,
      }
    );

    console.log(
      "🧠 Long-term memory updated"
    );
    console.log(
      `   ${memoryText}`
    );
  } catch (error) {
    console.error(
      "❌ Failed to update memory:",
      error.message
    );
  }
}

// ============================================================
// DELETE MEMORY
// ============================================================

async function deleteMemory({
  userId,
  memoryText,
}) {
  try {
    const memories =
      await Memory.find({
        userId,
      }).lean();

    const related =
      findRelatedMemory(
        memories,
        memoryText
      );

    if (!related) {
      return;
    }

    await Memory.findByIdAndDelete(
      related._id
    );

    console.log(
      "🗑️ Long-term memory deleted"
    );
    console.log(
      `   ${related.memory}`
    );
  } catch (error) {
    console.error(
      "❌ Failed to delete memory:",
      error.message
    );
  }
}

// ============================================================
// PROCESS MEMORY ACTION
// ============================================================

async function processMemoryAction({
  userId,
  username,
  memory,
}) {
  if (!memory) {
    return;
  }

  const action =
    VALID_MEMORY_ACTIONS.includes(
      memory.action
    )
      ? memory.action
      : "none";

  if (
    action === "none"
  ) {
    return;
  }

  if (!memory.text) {
    return;
  }

  if (action === "save") {
    await saveMemory({
      userId,
      username,
      memoryText: memory.text,
      category:
        memory.category,
      importance:
        memory.importance,
      expiresAt:
        memory.expiresAt,
    });
  }

  if (action === "update") {
    await updateMemory({
      userId,
      username,
      memoryText: memory.text,
      category:
        memory.category,
      importance:
        memory.importance,
      expiresAt:
        memory.expiresAt,
    });
  }

  if (action === "delete") {
    await deleteMemory({
      userId,
      memoryText: memory.text,
    });
  }
}

// ============================================================
// GEMINI RESPONSE PARSER
// ============================================================

function parseNovaResponse(text) {
  try {
    let cleaned =
      text.trim();

    if (
      cleaned.startsWith(
        "```json"
      )
    ) {
      cleaned =
        cleaned
          .replace(
            /^```json/,
            ""
          )
          .replace(
            /```$/,
            ""
          )
          .trim();
    }

    if (
      cleaned.startsWith(
        "```"
      )
    ) {
      cleaned =
        cleaned
          .replace(
            /^```/,
            ""
          )
          .replace(
            /```$/,
            ""
          )
          .trim();
    }

    const parsed =
      JSON.parse(cleaned);

    return {
      reply:
        typeof parsed.reply ===
        "string"
          ? parsed.reply
          : "Yeah lol.",
      memory:
        parsed.memory || {
          action: "none",
        },
    };
  } catch (error) {
    console.log(
      "⚠️ Gemini returned invalid JSON. Using fallback."
    );

    return {
      reply: text,
      memory: {
        action: "none",
      },
    };
  }
}

// ============================================================
// GEMINI CHAT
// ============================================================

async function generateNovaResponse({
  username,
  userMessage,
  recentMessages,
  longTermMemories,
}) {
  const conversationText =
    recentMessages.length > 0
      ? recentMessages
          .map(
            (item) =>
              `${
                item.role ===
                "user"
                  ? item.username
                  : "Nova"
              }: ${item.message}`
          )
          .join("\n")
      : "No previous conversation.";

  const memoryText =
    longTermMemories.length > 0
      ? longTermMemories
          .map(
            (memory) =>
              `- [${memory.category}] ${memory.memory}`
          )
          .join("\n")
      : "No long-term memories.";

  const prompt = `
You are Nova, a Discord AI bot.

IDENTITY:
- You are male.
- You are a 20-year-old guy.
- You naturally behave like a 20-year-old guy chatting on Discord.
- Do not constantly mention your age or gender.
- Never describe yourself as female.
- Never call yourself Gemini.
- Your name is Nova.

PERSONALITY:
- Casual
- Playful
- Witty
- Friendly
- Sometimes sarcastic
- Sometimes teasing
- Socially aware
- Emotionally aware
- Natural
- Understand sarcasm, irony, jokes, slang, memes and context.
- Match the user's energy.
- Usually answer in 1-3 sentences unless more detail is needed.
- Do not sound robotic or overly formal.

CURRENT USER:
${username}

CURRENT MESSAGE:
${userMessage}

RECENT CONVERSATION:
${conversationText}

LONG-TERM MEMORIES:
${memoryText}

MEMORY RULE:

Only save information that would genuinely make future conversations
with this person better.

Ask yourself:
"Would knowing this several days or weeks from now make my conversation
with this person better?"

SAVE examples:
- User's name
- User's hobbies
- User's favorite games
- User's studies
- User's job
- Important personal preferences
- Important relationships
- Long-term goals

TEMPORARY examples:
- Exam tomorrow
- Test next Friday
- Assignment due tomorrow
- Meeting next week
- Trip next weekend

Do NOT save:
- Random reactions
- "lol"
- "bro"
- Casual jokes
- One-time meaningless statements
- Normal conversation that has no future value

TEMPORARY MEMORY:
If something is temporary, use:
"expiresAt": "relative"

Node.js will calculate the actual expiration date.

MEMORY CATEGORIES:
identity
preference
personal
interest
relationship
goal
important

MEMORY ACTIONS:
save
update
delete
none

Return ONLY valid JSON in exactly this structure:

{
  "reply": "Nova's normal Discord reply",
  "memory": {
    "action": "none",
    "text": "",
    "category": "",
    "importance": 0,
    "expiresAt": null
  }
}

IMPORTANT:
- The reply must be normal Discord text.
- Do not put JSON inside the reply.
- Do not use markdown code fences.
`;

  try {
    const result =
      await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
      });

    return result.text;
  } catch (error) {
    console.error(
      "❌ Gemini error:",
      error.message
    );

    return JSON.stringify({
      reply:
        "My brain just lagged 💀 try again.",
      memory: {
        action: "none",
      },
    });
  }
}

// ============================================================
// SPAM PROTECTION
// ============================================================

function isProtectedMember(member) {
  if (!member) {
    return true;
  }

  if (
    member.id ===
    client.user?.id
  ) {
    return true;
  }

  if (
    member.guild.ownerId ===
    member.id
  ) {
    return true;
  }

  if (
    member.permissions.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return true;
  }

  if (
    member.permissions.has(
      PermissionsBitField.Flags.ModerateMembers
    )
  ) {
    return true;
  }

  return false;
}

function cleanOldSpamMessages(userId) {
  const now = Date.now();

  const tracked =
    spamTracker.get(userId) || [];

  const recent =
    tracked.filter(
      (entry) =>
        now - entry.timestamp <=
        SPAM_WINDOW
    );

  spamTracker.set(
    userId,
    recent
  );

  return recent;
}

async function deleteSpamMessages(
  spamMessages
) {
  let deletedCount = 0;

  for (const entry of spamMessages) {
    try {
      if (!entry.message) {
        continue;
      }

      await entry.message.delete();

      deletedCount++;
    } catch (error) {
      console.log(
        `⚠️ Could not delete spam message: ${error.message}`
      );
    }
  }

  return deletedCount;
}

async function handleSpamDetection(
  message
) {
  if (!message.guild) {
    return false;
  }

  if (message.author.bot) {
    return false;
  }

  const member =
    message.member;

  if (
    isProtectedMember(member)
  ) {
    return false;
  }

  if (
    !member ||
    !member.moderatable
  ) {
    return false;
  }

  const botMember =
    message.guild.members.me;

  if (!botMember) {
    return false;
  }

  const canDeleteMessages =
    botMember.permissions.has(
      PermissionsBitField.Flags.ManageMessages
    );

  const recentMessages =
    cleanOldSpamMessages(
      message.author.id
    );

  recentMessages.push({
    message,
    timestamp: Date.now(),
  });

  spamTracker.set(
    message.author.id,
    recentMessages
  );

  const messageCount =
    recentMessages.length;

  // ----------------------------------------------------------
  // WARNING
  // ----------------------------------------------------------

  if (
    messageCount >=
      SPAM_WARNING_LIMIT &&
    messageCount <
      SPAM_TIMEOUT_LIMIT
  ) {
    if (
      !spamWarnings.has(
        message.author.id
      )
    ) {
      spamWarnings.set(
        message.author.id,
        Date.now()
      );

      await message.channel
        .send(
          `⚠️ ${message.author}, slow down a bit 💀`
        )
        .catch(() => {});
    }

    return false;
  }

  // ----------------------------------------------------------
  // TIMEOUT
  // ----------------------------------------------------------

  if (
    messageCount >=
    SPAM_TIMEOUT_LIMIT
  ) {
    const previousTimeout =
      spamTimeouts.get(
        message.author.id
      );

    const isRecentTimeout =
      previousTimeout &&
      Date.now() -
        previousTimeout <
        TIMEOUT_HISTORY;

    const timeoutDuration =
      isRecentTimeout
        ? REPEAT_TIMEOUT
        : FIRST_TIMEOUT;

    let deletedCount = 0;

    if (canDeleteMessages) {
      deletedCount =
        await deleteSpamMessages(
          recentMessages
        );
    }

    try {
      await member.timeout(
        timeoutDuration,
        `Automatic spam detection: ${messageCount} messages within ${SPAM_WINDOW / 1000} seconds`
      );

      spamTimeouts.set(
        message.author.id,
        Date.now()
      );

      const timeoutMinutes =
        timeoutDuration /
        60 /
        1000;

      await message.channel
        .send(
          `🔇 ${message.author} has been timed out for **${timeoutMinutes} minute${
            timeoutMinutes === 1
              ? ""
              : "s"
          }** for spamming${
            deletedCount > 0
              ? ` and ${deletedCount} spam message${
                  deletedCount === 1
                    ? ""
                    : "s"
                } were deleted.`
              : "."
          }`
        )
        .catch(() => {});

      spamTracker.delete(
        message.author.id
      );

      spamWarnings.delete(
        message.author.id
      );

      // IMPORTANT:
      // Tell the main message handler that
      // this message was moderated/deleted.
      return true;
    } catch (error) {
      console.error(
        `❌ Failed to timeout ${message.author.tag}:`,
        error.message
      );

      return false;
    }
  }

  return false;
}

// ============================================================
// SPAM TRACKER CLEANUP
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (
    const [
      userId,
      messages,
    ] of spamTracker.entries()
  ) {
    const recent =
      messages.filter(
        (entry) =>
          now - entry.timestamp <=
          SPAM_WINDOW
      );

    if (recent.length === 0) {
      spamTracker.delete(
        userId
      );
    } else {
      spamTracker.set(
        userId,
        recent
      );
    }
  }

  for (
    const [
      userId,
      warningTime,
    ] of spamWarnings.entries()
  ) {
    if (
      now - warningTime >
      60 * 1000
    ) {
      spamWarnings.delete(
        userId
      );
    }
  }

  for (
    const [
      userId,
      timeoutTime,
    ] of spamTimeouts.entries()
  ) {
    if (
      now - timeoutTime >
      TIMEOUT_HISTORY
    ) {
      spamTimeouts.delete(
        userId
      );
    }
  }
}, 10000);

// ============================================================
// GIPHY
// ============================================================

async function searchGiphy(
  searchTerm
) {
  if (!GIPHY_API_KEY) {
    console.log(
      "⚠️ GIPHY_API_KEY is missing."
    );

    return null;
  }

  try {
    const params =
      new URLSearchParams({
        api_key:
          GIPHY_API_KEY,

        q: searchTerm,

        limit: "10",

        rating: "g",

        lang: "en",
      });

    const response =
      await fetch(
        `https://api.giphy.com/v1/gifs/search?${params.toString()}`
      );

    if (!response.ok) {
      throw new Error(
        `GIPHY returned ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data.data ||
      data.data.length === 0
    ) {
      return null;
    }

    // Pick a random result from the first
    // few search results so greetings don't
    // always use the same GIF.
    const results =
      data.data.slice(
        0,
        Math.min(
          data.data.length,
          8
        )
      );

    const selected =
      results[
        Math.floor(
          Math.random() *
            results.length
        )
      ];

    return {
      url:
        selected.images
          ?.original
          ?.url ||
        selected.images
          ?.downsized
          ?.url ||
        selected.url,

      pageUrl:
        selected.url,
    };
  } catch (error) {
    console.error(
      "❌ GIPHY error:",
      error.message
    );

    return null;
  }
}

// ============================================================
// SERVER EMOJIS
// ============================================================

function getRandomServerEmoji(
  guild
) {
  const emojis =
    guild.emojis.cache;

  if (
    !emojis ||
    emojis.size === 0
  ) {
    return "";
  }

  const emojiArray =
    [...emojis.values()];

  const emoji =
    emojiArray[
      Math.floor(
        Math.random() *
          emojiArray.length
      )
    ];

  return emoji
    ? emoji.toString()
    : "";
}

// ============================================================
// FIND MEMBER
// ============================================================

async function findMemberByName(
  guild,
  name
) {
  const cleanName =
    name
      .trim()
      .replace(
        /^["']|["']$/g,
        ""
      );

  if (!cleanName) {
    return null;
  }

  // First check cached members.
  const cached =
    guild.members.cache.find(
      (member) =>
        member.user.username
          .toLowerCase() ===
          cleanName.toLowerCase() ||
        member.displayName
          .toLowerCase() ===
          cleanName.toLowerCase() ||
        member.user.globalName
          ?.toLowerCase() ===
          cleanName.toLowerCase()
    );

  if (cached) {
    return cached;
  }

  // Try Discord member search.
  try {
    const results =
      await guild.members.fetch({
        query: cleanName,
        limit: 10,
      });

    const member =
      results.find(
        (item) =>
          item.user.username
            .toLowerCase() ===
            cleanName.toLowerCase() ||
          item.displayName
            .toLowerCase() ===
            cleanName.toLowerCase() ||
          item.user.globalName
            ?.toLowerCase() ===
            cleanName.toLowerCase()
      );

    return member || null;
  } catch (error) {
    console.log(
      `⚠️ Could not search for member ${cleanName}: ${error.message}`
    );

    return null;
  }
}

// ============================================================
// GREETING COMMAND DETECTION
// ============================================================

function detectGreetingCommand(
  message
) {
  let text =
    message.content
      .replace(
        /<@!?\d+>/g,
        ""
      )
      .trim();

  const lower =
    text.toLowerCase();

  // ----------------------------------------------------------
  // EVERYONE
  // ----------------------------------------------------------

  const everyonePatterns = [
    /\bsay\s+(hi|hello|hey)\s+to\s+everyone\b/i,
    /\bsay\s+(hi|hello|hey)\s+everyone\b/i,
    /\bgreet\s+everyone\b/i,
    /\bsay\s+hi\s+everyone\b/i,
    /\bsay\s+hello\s+everyone\b/i,
    /\bsay\s+hey\s+everyone\b/i,
  ];

  if (
    everyonePatterns.some(
      (pattern) =>
        pattern.test(lower)
    )
  ) {
    return {
      type: "everyone",
    };
  }

  // ----------------------------------------------------------
  // EXPLICIT DISCORD MENTION
  // ----------------------------------------------------------

  const mentionedMember =
    message.mentions.members.first();

  if (mentionedMember) {
    const personPatterns = [
      /\bsay\s+(hi|hello|hey)\b/i,
      /\bgreet\b/i,
      /\bsay\s+hi\s+to\b/i,
      /\bsay\s+hello\s+to\b/i,
      /\bsay\s+hey\s+to\b/i,
    ];

    if (
      personPatterns.some(
        (pattern) =>
          pattern.test(text)
      )
    ) {
      return {
        type: "person",
        member:
          mentionedMember,
      };
    }
  }

  // ----------------------------------------------------------
  // NAME WITHOUT @
  // ----------------------------------------------------------

  const namePatterns = [
    /\bsay\s+(?:hi|hello|hey)\s+to\s+(.+)$/i,

    /\bgreet\s+(.+)$/i,

    /\bsay\s+(?:hi|hello|hey)\s+(.+)$/i,
  ];

  for (
    const pattern of namePatterns
  ) {
    const match =
      text.match(pattern);

    if (!match) {
      continue;
    }

    let targetName =
      match[1].trim();

    targetName =
      targetName
        .replace(
          /[.!?]+$/,
          ""
        )
        .trim();

    if (
      !targetName ||
      targetName
        .toLowerCase() ===
        "everyone"
    ) {
      continue;
    }

    return {
      type: "person_name",
      name: targetName,
    };
  }

  return null;
}

// ============================================================
// GREETING SYSTEM
// ============================================================

async function handleGreeting(
  message
) {
  if (!message.guild) {
    return false;
  }

  const command =
    detectGreetingCommand(
      message
    );

  if (!command) {
    return false;
  }

  // ----------------------------------------------------------
  // EVERYONE GREETING
  // ----------------------------------------------------------

  if (
    command.type ===
    "everyone"
  ) {
    const botMember =
      message.guild.members.me;

    if (!botMember) {
      return false;
    }

    const canMentionEveryone =
      botMember.permissions.has(
        PermissionsBitField.Flags
          .MentionEveryone
      );

    if (!canMentionEveryone) {
      await message.reply(
        "I need the **Mention Everyone** permission for that 😭"
      );

      return true;
    }

    const emoji =
      getRandomServerEmoji(
        message.guild
      );

    const gif =
      await searchGiphy(
        "funny hello everyone waving"
      );

    const greetings = [
      "Hey everyone! 👋",
      "Yo everyone! 😭",
      "Ayo everyone, what's good? 😂",
      "Heyyy everyone! 👋🔥",
      "What's up everyone? 😎",
      "Yo people! 👋",
    ];

    const greeting =
      greetings[
        Math.floor(
          Math.random() *
            greetings.length
        )
      ];

    const content =
      `@everyone ${greeting} ${
        emoji || ""
      }`;

    await message.channel.send({
      content,

      allowedMentions: {
        parse: ["everyone"],
      },
    });

    if (gif) {
      await message.channel.send({
        content:
          `Powered by GIPHY: ${gif.pageUrl}`,
      });

      await message.channel.send({
        content: gif.url,
      });
    }

    console.log(
      "👋 Nova greeted everyone."
    );

    return true;
  }

  // ----------------------------------------------------------
  // SPECIFIC MEMBER
  // ----------------------------------------------------------

  let member =
    command.member;

  // ----------------------------------------------------------
  // NAME SEARCH
  // ----------------------------------------------------------

  if (
    command.type ===
    "person_name"
  ) {
    member =
      await findMemberByName(
        message.guild,
        command.name
      );

    if (!member) {
      await message.reply(
        `I couldn't find **${command.name}** in this server 😭`
      );

      return true;
    }
  }

  if (!member) {
    return false;
  }

  // Don't allow Nova to greet itself.
  if (
    member.id ===
    client.user.id
  ) {
    await message.reply(
      "Bro I'm already here 💀"
    );

    return true;
  }

  const emoji =
    getRandomServerEmoji(
      message.guild
    );

  const gif =
    await searchGiphy(
      "funny hello hi waving"
    );

  const greetings = [
    `Hey ${member}! 👋`,
    `Yo ${member}! What's good? 😎`,
    `Ayo ${member}! 👋😂`,
    `Heyyy ${member}! 🔥`,
    `What's up ${member}? 👋`,
    `Yo ${member}, Nova says hi 😭`,
  ];

  const greeting =
    greetings[
      Math.floor(
        Math.random() *
          greetings.length
      )
    ];

  await message.channel.send({
    content:
      `${greeting} ${
        emoji || ""
      }`,

    allowedMentions: {
      users: [member.id],
    },
  });

  if (gif) {
    await message.channel.send({
      content:
        `Powered by GIPHY: ${gif.pageUrl}`,
    });

    await message.channel.send({
      content: gif.url,
    });
  }

  console.log(
    `👋 Nova greeted ${member.user.tag}`
  );

  return true;
}

// ============================================================
// READY
// ============================================================

client.once(
  "ready",
  () => {
    console.log("");
    console.log(
      "================================"
    );
    console.log(
      `🤖 Nova is online as ${client.user.tag}`
    );
    console.log(
      "================================"
    );

    console.log(
      "🧠 MongoDB memory enabled"
    );

    console.log(
      "🧠 Automatic long-term memory enabled"
    );

    console.log(
      "🧠 Memory updates enabled"
    );

    console.log(
      "🗑️ Memory deletion enabled"
    );

    console.log(
      "⏳ Temporary memories enabled"
    );

    console.log(
      "📅 Relative date detection enabled"
    );

    console.log(
      "🛡️ Automatic spam detection enabled"
    );

    console.log(
      "🔇 Automatic spam timeout enabled"
    );

    console.log(
      "🗑️ Automatic spam deletion enabled"
    );

    console.log(
      "👋 Greeting system enabled"
    );

    console.log(
      "🎬 GIPHY GIF system enabled"
    );

    console.log(
      "😀 Server emoji system enabled"
    );

    console.log(
      "👨 Nova identity: male, 20 years old"
    );

    console.log(
      `⚙️ Spam threshold: ${SPAM_TIMEOUT_LIMIT} messages / ${
        SPAM_WINDOW / 1000
      }s`
    );

    console.log("");
  }
);

// ============================================================
// MESSAGE HANDLER
// ============================================================

client.on(
  "messageCreate",
  async (message) => {
    try {
      // Ignore bots.
      if (
        message.author.bot
      ) {
        return;
      }

      // ------------------------------------------------------
      // SPAM DETECTION
      // ------------------------------------------------------

      const wasModerated =
        await handleSpamDetection(
          message
        );

      // If Nova deleted/timed out the
      // message, don't continue processing it.
      if (wasModerated) {
        return;
      }

      // ------------------------------------------------------
      // GREETING SYSTEM
      // ------------------------------------------------------

      const greetingHandled =
        await handleGreeting(
          message
        );

      if (greetingHandled) {
        return;
      }

      // ------------------------------------------------------
      // NORMAL NOVA CHAT
      // ------------------------------------------------------

      const content =
        message.content;

      const lowerContent =
        content.toLowerCase();

      const mentionsNova =
        message.mentions.has(
          client.user
        );

      const saysNova =
        /\bnova\b/i.test(
          lowerContent
        );

      if (
        !mentionsNova &&
        !saysNova
      ) {
        return;
      }

      // Remove Nova mention/name
      // before sending to Gemini.
      const cleanedMessage =
        content
          .replace(
            /<@!?\d+>/g,
            ""
          )
          .replace(
            /\bnova\b/gi,
            ""
          )
          .trim();

      if (!cleanedMessage) {
        await message.reply(
          "Yeah? 👀"
        );

        return;
      }

      const userId =
        message.author.id;

      const username =
        message.member
          ?.displayName ||
        message.author
          .globalName ||
        message.author.username;

      // ------------------------------------------------------
      // SAVE USER MESSAGE
      // ------------------------------------------------------

      await saveConversation(
        userId,
        username,
        "user",
        cleanedMessage
      );

      // ------------------------------------------------------
      // LOAD MEMORY
      // ------------------------------------------------------

      const recentMessages =
        await loadRecentConversation(
          userId
        );

      const longTermMemories =
        await loadLongTermMemories(
          userId
        );

      // ------------------------------------------------------
      // GEMINI
      // ------------------------------------------------------

      const rawResponse =
        await generateNovaResponse({
          username,
          userMessage:
            cleanedMessage,
          recentMessages,
          longTermMemories,
        });

      const parsed =
        parseNovaResponse(
          rawResponse
        );

      // ------------------------------------------------------
      // SEND NOVA RESPONSE
      // ------------------------------------------------------

      await message.reply(
        parsed.reply
      );

      // ------------------------------------------------------
      // SAVE NOVA RESPONSE
      // ------------------------------------------------------

      await saveConversation(
        userId,
        "Nova",
        "nova",
        parsed.reply
      );

      // ------------------------------------------------------
      // PROCESS LONG-TERM MEMORY
      // ------------------------------------------------------

      await processMemoryAction({
        userId,
        username,
        memory:
          parsed.memory,
      });
    } catch (error) {
      console.error(
        "❌ Message handler error:",
        error
      );
    }
  }
);

// ============================================================
// START BOT
// ============================================================

async function startBot() {
  if (!DISCORD_TOKEN) {
    console.error(
      "❌ DISCORD_TOKEN is missing from .env"
    );

    process.exit(1);
  }

  if (!GEMINI_API_KEY) {
    console.error(
      "❌ GEMINI_API_KEY is missing from .env"
    );

    process.exit(1);
  }

  if (!MONGO_URI) {
    console.error(
      "❌ MONGO_URI is missing from .env"
    );

    process.exit(1);
  }

  if (!GIPHY_API_KEY) {
    console.warn(
      "⚠️ GIPHY_API_KEY is missing. GIF greetings will not work."
    );
  }

  await connectMongoDB();

  await client.login(
    DISCORD_TOKEN
  );
}

startBot();