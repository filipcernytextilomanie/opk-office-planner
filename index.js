const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require("discord.js");

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPK_ROLE_ID = process.env.OPK_ROLE_ID;
const SCHEDULER_KEY = process.env.SCHEDULER_KEY;

const CAPACITY = 9;
const DAYS = ["Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek"];
const SHORT_DAYS = ["Po", "Út", "St", "Čt", "Pá"];

const DATA_FILE = path.join(__dirname, "data.json");

function defaultData() {
  return {
    currentPollMessageId: null,
    polls: {}
  };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();

    const raw = fs.readFileSync(DATA_FILE, "utf8");
    if (!raw.trim()) return defaultData();

    const data = JSON.parse(raw);

    if (!data.polls) data.polls = {};

    return data;
  } catch (error) {
    console.error("DATA LOAD ERROR:", error);
    return defaultData();
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("DATA SAVE ERROR:", error);
  }
}

function getNextWeekDays() {
  const today = new Date();
  const currentDay = today.getDay();
  const daysUntilNextMonday = ((8 - currentDay) % 7) || 7;

  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilNextMonday);

  return DAYS.map((name, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);

    return {
      name,
      shortName: SHORT_DAYS[index],
      date: date.toLocaleDateString("cs-CZ", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      })
    };
  });
}

function emptyAttendance() {
  const attendance = {};
  DAYS.forEach(day => {
    attendance[day] = [];
  });
  return attendance;
}

function normalizeAttendance(attendance) {
  const normalized = emptyAttendance();

  DAYS.forEach(day => {
    if (Array.isArray(attendance?.[day])) {
      normalized[day] = [...new Set(attendance[day])];
    }
  });

  return normalized;
}

function createEmbed(poll) {
  poll.attendance = normalizeAttendance(poll.attendance);

  const weekStart = poll.days[0].date;
  const weekEnd = poll.days[4].date;

  const description = poll.days
    .map(dayInfo => {
      const people = poll.attendance[dayInfo.name] || [];

      const list = people.length
        ? people.map(id => `• <@${id}>`).join("\n")
        : "_Nikdo přihlášen_";

      return (
        `**${dayInfo.name} / ${dayInfo.shortName} ${dayInfo.date} ` +
        `(${people.length}/${CAPACITY})**\n${list}`
      );
    })
    .join("\n\n");

  return new EmbedBuilder()
    .setTitle(
      poll.locked
        ? "Přítomnost v kanceláři OPK – UZAVŘENO"
        : "Přítomnost v kanceláři OPK"
    )
    .setDescription(
      `**Týden ${weekStart} – ${weekEnd}**\n\n${description}`
    )
    .setFooter({
      text: poll.locked
        ? "Hlasování je uzamčeno. Výsledky zůstávají viditelné."
        : "Anketa je otevřená v pátek od 8:00 do 16:00. Kliknutím na den se přihlásíte nebo odhlásíte."
    });
}

function createButtons(poll) {
  poll.attendance = normalizeAttendance(poll.attendance);

  const row = new ActionRowBuilder();

  poll.days.forEach(dayInfo => {
    const people = poll.attendance[dayInfo.name] || [];

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`day_${dayInfo.name}`)
        .setLabel(
          `${dayInfo.shortName} ${dayInfo.date} (${people.length}/${CAPACITY})`
        )
        .setStyle(ButtonStyle.Primary)
        .setDisabled(poll.locked || people.length >= CAPACITY)
    );
  });

  return [row];
}

async function waitForDiscord(timeoutSeconds = 90) {
  if (client.isReady()) return true;

  console.log("waitForDiscord(): čekám na Discord...");

  for (let i = 0; i < timeoutSeconds; i++) {
    if (client.isReady()) {
      console.log("waitForDiscord(): Discord je připraven.");
      return true;
    }

    if (i % 10 === 0) {
      console.log(
        `waitForDiscord(): ${i}s | ws.status=${client.ws.status} | ready=${client.isReady()}`
      );
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.error(
    `waitForDiscord(): timeout po ${timeoutSeconds}s | ws.status=${client.ws.status}`
  );

  return false;
}

async function sendPoll() {
  const ready = await waitForDiscord();

  if (!ready) {
    throw new Error("Bot není připojen k Discordu.");
  }

  const data = loadData();

  const poll = {
    locked: false,
    days: getNextWeekDays(),
    attendance: emptyAttendance()
  };

  const channel = await client.channels.fetch(CHANNEL_ID);

  if (!channel || !channel.isTextBased()) {
    throw new Error("CHANNEL_ID nepatří textovému kanálu.");
  }

  const message = await channel.send({
    content:
      `<@&${OPK_ROLE_ID}> 📅 Prosím vyplňte přítomnost v kanceláři na příští týden.`,
    embeds: [createEmbed(poll)],
    components: createButtons(poll),
    allowedMentions: {
      roles: [OPK_ROLE_ID]
    }
  });

  data.currentPollMessageId = message.id;
  data.polls[message.id] = poll;

  saveData(data);

  console.log(`Anketa byla odeslána. Message ID: ${message.id}`);

  return message.id;
}

async function lockPoll() {
  const ready = await waitForDiscord();

  if (!ready) {
    throw new Error("Bot není připojen k Discordu.");
  }

  const data = loadData();
  const messageId = data.currentPollMessageId;

  if (!messageId || !data.polls[messageId]) {
    console.log("Není uložená žádná aktuální anketa.");
    return false;
  }

  const poll = data.polls[messageId];
  poll.attendance = normalizeAttendance(poll.attendance);
  poll.locked = true;

  const channel = await client.channels.fetch(CHANNEL_ID);
  const message = await channel.messages.fetch(messageId);

  await message.edit({
    embeds: [createEmbed(poll)],
    components: createButtons(poll)
  });

  data.polls[messageId] = poll;
  saveData(data);

  console.log("Anketa byla uzamčena.");

  return true;
}

/* WEB */

app.get("/", (req, res) => {
  res.status(200).json({
    web: true,
    discordReady: client.isReady(),
    wsStatus: client.ws.status,
    discordUser: client.user?.tag || null
  });
});

app.get("/status", (req, res) => {
  res.json({
    web: true,
    discordReady: client.isReady(),
    wsStatus: client.ws.status,
    discordUser: client.user?.tag || null,
    channelConfigured: Boolean(CHANNEL_ID),
    roleConfigured: Boolean(OPK_ROLE_ID),
    schedulerConfigured: Boolean(SCHEDULER_KEY)
  });
});

app.get("/send-poll", async (req, res) => {
  try {
    if (!SCHEDULER_KEY || req.query.key !== SCHEDULER_KEY) {
      return res.status(403).send("Neplatný klíč.");
    }

    const id = await sendPoll();

    return res.status(200).send(
      `Anketa byla vytvořena. ID: ${id}`
    );
  } catch (error) {
    console.error("Chyba /send-poll:", error);

    return res.status(500).send(
      "Anketu se nepodařilo vytvořit."
    );
  }
});

app.get("/lock-poll", async (req, res) => {
  try {
    if (!SCHEDULER_KEY || req.query.key !== SCHEDULER_KEY) {
      return res.status(403).send("Neplatný klíč.");
    }

    const result = await lockPoll();

    if (!result) {
      return res.status(404).send(
        "Nebyla nalezena žádná anketa."
      );
    }

    return res.status(200).send(
      "Anketa byla uzavřena."
    );
  } catch (error) {
    console.error("Chyba /lock-poll:", error);

    return res.status(500).send(
      "Anketu se nepodařilo uzavřít."
    );
  }
});

/* DISCORD EVENTS */

client.once(Events.ClientReady, async readyClient => {
  console.log("================================");
  console.log(`DISCORD READY: ${readyClient.user.tag}`);
  console.log(`USER ID: ${readyClient.user.id}`);
  console.log(`WS STATUS: ${client.ws.status}`);
  console.log("================================");

  try {
    await client.application.commands.set([
      {
        name: "anketa",
        description:
          "Ručně vytvoří novou anketu přítomnosti v kanceláři OPK."
      },
      {
        name: "uzavrit",
        description:
          "Ručně uzavře poslední vytvořenou anketu OPK."
      }
    ]);

    console.log("Slash příkazy zaregistrovány.");
  } catch (error) {
    console.error("Chyba registrace slash příkazů:", error);
  }
});

client.on("debug", info => {
  if (
    info.includes("WebSocket") ||
    info.includes("gateway") ||
    info.includes("Gateway") ||
    info.includes("Heartbeat") ||
    info.includes("Identify") ||
    info.includes("Session")
  ) {
    console.log(`[DISCORD DEBUG] ${info}`);
  }
});

client.on("warn", info => {
  console.warn("[DISCORD WARN]", info);
});

client.on("error", error => {
  console.error("[DISCORD ERROR]", error);
});

client.ws.on("debug", info => {
  console.log("[WS DEBUG]", info);
});

client.ws.on("error", error => {
  console.error("[WS ERROR]", error);
});

client.ws.on("close", event => {
  console.error(
    `[WS CLOSE] code=${event.code} reason=${event.reason || "bez důvodu"}`
  );
});

client.ws.on("invalidated", () => {
  console.error("[WS INVALIDATED] Discord session invalidated.");
});

/* INTERACTIONS */

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "anketa") {
        await interaction.reply({
          content: "Vytvářím novou anketu...",
          ephemeral: true
        });

        await sendPoll();

        await interaction.editReply({
          content: "Nová anketa byla vytvořena."
        });

        return;
      }

      if (interaction.commandName === "uzavrit") {
        await interaction.reply({
          content: "Uzavírám aktuální anketu...",
          ephemeral: true
        });

        const result = await lockPoll();

        await interaction.editReply({
          content: result
            ? "Anketa byla uzavřena."
            : "Není žádná aktuální anketa k uzavření."
        });

        return;
      }
    }

    if (!interaction.isButton()) return;

    await interaction.deferUpdate();

    const data = loadData();
    const messageId = interaction.message.id;
    const poll = data.polls[messageId];

    if (!poll) {
      console.log(
        `Chybí data pro anketu. Message ID: ${messageId}`
      );
      return;
    }

    poll.attendance = normalizeAttendance(poll.attendance);

    if (poll.locked) return;

    const day = interaction.customId.replace("day_", "");
    const userId = interaction.user.id;

    if (!DAYS.includes(day)) return;

    const people = poll.attendance[day] || [];

    if (people.includes(userId)) {
      poll.attendance[day] = people.filter(
        id => id !== userId
      );
    } else {
      if (people.length >= CAPACITY) return;

      poll.attendance[day] = [
        ...people,
        userId
      ];
    }

    data.polls[messageId] = poll;

    saveData(data);

    await interaction.message.edit({
      embeds: [createEmbed(poll)],
      components: createButtons(poll)
    });
  } catch (error) {
    console.error("Chyba při Discord interakci:", error);
  }
});

/* PROCESS ERRORS */

process.on("unhandledRejection", error => {
  console.error("[UNHANDLED REJECTION]", error);
});

process.on("uncaughtException", error => {
  console.error("[UNCAUGHT EXCEPTION]", error);
});

/* WEB START */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Web server běží na portu ${PORT}.`);
});

/* DISCORD LOGIN */

async function loginWithTimeout() {
  console.log("================================");
  console.log("START DISCORD LOGIN");
  console.log(`Token nastaven: ${Boolean(TOKEN)}`);
  console.log(`Token délka: ${TOKEN ? TOKEN.length : 0}`);
  console.log(`Počáteční ws.status: ${client.ws.status}`);
  console.log("================================");

  if (!TOKEN) {
    console.error("DISCORD_TOKEN CHYBÍ.");
    return;
  }

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          `client.login timeout po 60 sekundách. ws.status=${client.ws.status}`
        )
      );
    }, 60000);
  });

  try {
    await Promise.race([
      client.login(TOKEN),
      timeout
    ]);

    console.log("client.login() promise dokončen.");
  } catch (error) {
    console.error("================================");
    console.error("DISCORD LOGIN SELHAL:");
    console.error(error);
    console.error(`ws.status=${client.ws.status}`);
    console.error("================================");
  }
}
async function testDiscordGateway() {
  try {
    console.log("TEST: Zkouším Discord Gateway HTTP endpoint...");

    const response = await fetch("https://discord.com/api/v10/gateway");

    console.log("TEST: Gateway HTTP status:", response.status);

    const data = await response.json();

    console.log("TEST: Gateway URL:", data.url);
  } catch (error) {
    console.error("TEST: Discord Gateway HTTP SELHAL:");
    console.error(error);
  }
}

testDiscordGateway();
loginWithTimeout();
