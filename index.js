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

// =====================================================
// ZÁKLADNÍ NASTAVENÍ
// =====================================================

const app = express();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPK_ROLE_ID = process.env.OPK_ROLE_ID;
const SCHEDULER_KEY = process.env.SCHEDULER_KEY;

const CAPACITY = 9;

const DAYS = [
  "Pondělí",
  "Úterý",
  "Středa",
  "Čtvrtek",
  "Pátek"
];

const SHORT_DAYS = [
  "Po",
  "Út",
  "St",
  "Čt",
  "Pá"
];

const DATA_FILE = path.join(__dirname, "data.json");


// =====================================================
// KONTROLA ENVIRONMENT VARIABLES
// =====================================================

console.log("Kontroluji Environment Variables...");

console.log(
  "DISCORD_TOKEN:",
  TOKEN ? "NASTAVEN" : "CHYBÍ"
);

console.log(
  "CHANNEL_ID:",
  CHANNEL_ID ? "NASTAVEN" : "CHYBÍ"
);

console.log(
  "OPK_ROLE_ID:",
  OPK_ROLE_ID ? "NASTAVEN" : "CHYBÍ"
);

console.log(
  "SCHEDULER_KEY:",
  SCHEDULER_KEY ? "NASTAVEN" : "CHYBÍ"
);


// =====================================================
// DATA
// =====================================================

function createDefaultData() {
  return {
    currentPollMessageId: null,
    polls: {}
  };
}


function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return createDefaultData();
    }

    const raw = fs.readFileSync(DATA_FILE, "utf8");

    if (!raw.trim()) {
      return createDefaultData();
    }

    const parsed = JSON.parse(raw);

    if (!parsed.polls) {
      parsed.polls = {};
    }

    return parsed;

  } catch (error) {
    console.error(
      "Chyba při načítání data.json:",
      error
    );

    return createDefaultData();
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
    console.error(
      "Chyba při ukládání data.json:",
      error
    );
  }
}


// =====================================================
// DATUM PŘÍŠTÍHO TÝDNE
// =====================================================

function getNextWeekDays() {
  const today = new Date();

  const currentDay = today.getDay();

  const daysUntilNextMonday =
    ((8 - currentDay) % 7) || 7;

  const monday = new Date(today);

  monday.setDate(
    today.getDate() + daysUntilNextMonday
  );

  return DAYS.map((dayName, index) => {
    const date = new Date(monday);

    date.setDate(
      monday.getDate() + index
    );

    return {
      name: dayName,

      shortName: SHORT_DAYS[index],

      date: date.toLocaleDateString(
        "cs-CZ",
        {
          day: "2-digit",
          month: "2-digit",
          year: "numeric"
        }
      )
    };
  });
}


// =====================================================
// DOCHÁZKA
// =====================================================

function createEmptyAttendance() {
  const attendance = {};

  DAYS.forEach(day => {
    attendance[day] = [];
  });

  return attendance;
}


function normalizeAttendance(attendance) {
  const normalized = createEmptyAttendance();

  DAYS.forEach(day => {
    if (Array.isArray(attendance?.[day])) {
      normalized[day] = [
        ...new Set(attendance[day])
      ];
    }
  });

  return normalized;
}


// =====================================================
// EMBED
// =====================================================

function createEmbed(poll) {
  poll.attendance = normalizeAttendance(
    poll.attendance
  );

  const weekStart = poll.days[0].date;
  const weekEnd = poll.days[4].date;

  const description = poll.days
    .map(dayInfo => {
      const people =
        poll.attendance[dayInfo.name] || [];

      const list = people.length
        ? people
            .map(id => `• <@${id}>`)
            .join("\n")
        : "_Nikdo přihlášen_";

      return (
        `**${dayInfo.name} / ` +
        `${dayInfo.shortName} ` +
        `${dayInfo.date} ` +
        `(${people.length}/${CAPACITY})**\n` +
        list
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


// =====================================================
// TLAČÍTKA
// =====================================================

function createButtons(poll) {
  poll.attendance = normalizeAttendance(
    poll.attendance
  );

  const row = new ActionRowBuilder();

  poll.days.forEach(dayInfo => {
    const people =
      poll.attendance[dayInfo.name] || [];

    const isFull =
      people.length >= CAPACITY;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          `day_${dayInfo.name}`
        )
        .setLabel(
          `${dayInfo.shortName} ` +
          `${dayInfo.date} ` +
          `(${people.length}/${CAPACITY})`
        )
        .setStyle(
          ButtonStyle.Primary
        )
        .setDisabled(
          poll.locked || isFull
        )
    );
  });

  return [row];
}


// =====================================================
// ČEKÁNÍ NA DISCORD
// =====================================================

async function waitForDiscord(
  timeoutSeconds = 90
) {
  if (client.isReady()) {
    return true;
  }

  console.log(
    "Discord zatím není připraven. Čekám..."
  );

  for (
    let i = 0;
    i < timeoutSeconds;
    i++
  ) {
    if (client.isReady()) {
      console.log(
        "Discord je nyní připraven."
      );

      return true;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 1000)
    );
  }

  console.error(
    `Discord se nepřipojil ani po ${timeoutSeconds} sekundách.`
  );

  return false;
}


// =====================================================
// VYTVOŘENÍ ANKETY
// =====================================================

async function sendPoll() {
  console.log(
    "Spouštím vytvoření nové ankety..."
  );

  const ready = await waitForDiscord();

  if (!ready) {
    throw new Error(
      "Bot není připojen k Discordu."
    );
  }

  const data = loadData();

  const poll = {
    locked: false,
    days: getNextWeekDays(),
    attendance: createEmptyAttendance()
  };

  console.log(
    `Načítám Discord kanál ${CHANNEL_ID}...`
  );

  const channel =
    await client.channels.fetch(
      CHANNEL_ID
    );

  if (!channel) {
    throw new Error(
      "Discord kanál nebyl nalezen."
    );
  }

  if (!channel.isTextBased()) {
    throw new Error(
      "CHANNEL_ID nepatří textovému kanálu."
    );
  }

  console.log(
    "Kanál nalezen. Odesílám anketu..."
  );

  const message =
    await channel.send({
      content:
        `<@&${OPK_ROLE_ID}> 📅 ` +
        `Prosím vyplňte přítomnost v kanceláři na příští týden.`,

      embeds: [
        createEmbed(poll)
      ],

      components:
        createButtons(poll),

      allowedMentions: {
        roles: [
          OPK_ROLE_ID
        ]
      }
    });

  data.currentPollMessageId =
    message.id;

  data.polls[message.id] =
    poll;

  saveData(data);

  console.log(
    `Anketa byla odeslána. Message ID: ${message.id}`
  );

  return message.id;
}


// =====================================================
// UZAVŘENÍ ANKETY
// =====================================================

async function lockPoll() {
  console.log(
    "Spouštím uzavření ankety..."
  );

  const ready = await waitForDiscord();

  if (!ready) {
    throw new Error(
      "Bot není připojen k Discordu."
    );
  }

  const data = loadData();

  const messageId =
    data.currentPollMessageId;

  if (
    !messageId ||
    !data.polls[messageId]
  ) {
    console.log(
      "Není uložená žádná aktuální anketa."
    );

    return false;
  }

  const poll =
    data.polls[messageId];

  poll.attendance =
    normalizeAttendance(
      poll.attendance
    );

  poll.locked = true;

  const channel =
    await client.channels.fetch(
      CHANNEL_ID
    );

  const message =
    await channel.messages.fetch(
      messageId
    );

  await message.edit({
    embeds: [
      createEmbed(poll)
    ],

    components:
      createButtons(poll)
  });

  data.polls[messageId] =
    poll;

  saveData(data);

  console.log(
    "Anketa byla uzamčena."
  );

  return true;
}


// =====================================================
// WEB SERVER
// =====================================================

app.get("/", (req, res) => {
  res.status(200).send(
    client.isReady()
      ? "OPK bot běží a Discord je připojen."
      : "OPK web běží, Discord zatím není připojen."
  );
});


// =====================================================
// STATUS
// =====================================================

app.get("/status", (req, res) => {
  res.json({
    web: true,
    discordReady: client.isReady(),
    discordUser:
      client.user?.tag || null,
    channelConfigured:
      Boolean(CHANNEL_ID),
    roleConfigured:
      Boolean(OPK_ROLE_ID),
    schedulerConfigured:
      Boolean(SCHEDULER_KEY)
  });
});


// =====================================================
// EXTERNÍ ODESLÁNÍ ANKETY
// =====================================================

app.get(
  "/send-poll",
  async (req, res) => {
    try {
      if (
        !SCHEDULER_KEY ||
        req.query.key !==
          SCHEDULER_KEY
      ) {
        return res
          .status(403)
          .send(
            "Neplatný klíč."
          );
      }

      const messageId =
        await sendPoll();

      return res
        .status(200)
        .send(
          `Anketa byla vytvořena. ID: ${messageId}`
        );

    } catch (error) {
      console.error(
        "Chyba /send-poll:"
      );

      console.error(error);

      return res
        .status(500)
        .send(
          "Anketu se nepodařilo vytvořit."
        );
    }
  }
);


// =====================================================
// EXTERNÍ UZAVŘENÍ ANKETY
// =====================================================

app.get(
  "/lock-poll",
  async (req, res) => {
    try {
      if (
        !SCHEDULER_KEY ||
        req.query.key !==
          SCHEDULER_KEY
      ) {
        return res
          .status(403)
          .send(
            "Neplatný klíč."
          );
      }

      const success =
        await lockPoll();

      if (!success) {
        return res
          .status(404)
          .send(
            "Nebyla nalezena žádná anketa."
          );
      }

      return res
        .status(200)
        .send(
          "Anketa byla uzavřena."
        );

    } catch (error) {
      console.error(
        "Chyba /lock-poll:"
      );

      console.error(error);

      return res
        .status(500)
        .send(
          "Anketu se nepodařilo uzavřít."
        );
    }
  }
);


// =====================================================
// DISCORD READY
// =====================================================

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      "======================================"
    );

    console.log(
      `DISCORD PŘIPOJEN: ${readyClient.user.tag}`
    );

    console.log(
      `Discord User ID: ${readyClient.user.id}`
    );

    console.log(
      "======================================"
    );

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

      console.log(
        "Příkazy /anketa a /uzavrit byly zaregistrovány."
      );

    } catch (error) {
      console.error(
        "Chyba při registraci příkazů:"
      );

      console.error(error);
    }
  }
);


// =====================================================
// INTERAKCE
// =====================================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {

      // -------------------------------------------------
      // SLASH PŘÍKAZY
      // -------------------------------------------------

      if (
        interaction.isChatInputCommand()
      ) {

        if (
          interaction.commandName ===
          "anketa"
        ) {
          await interaction.reply({
            content:
              "Vytvářím novou anketu...",
            ephemeral: true
          });

          await sendPoll();

          await interaction.editReply({
            content:
              "Nová anketa byla vytvořena."
          });

          return;
        }


        if (
          interaction.commandName ===
          "uzavrit"
        ) {
          await interaction.reply({
            content:
              "Uzavírám aktuální anketu...",
            ephemeral: true
          });

          const result =
            await lockPoll();

          await interaction.editReply({
            content: result
              ? "Anketa byla uzavřena."
              : "Není žádná aktuální anketa k uzavření."
          });

          return;
        }
      }


      // -------------------------------------------------
      // TLAČÍTKA
      // -------------------------------------------------

      if (!interaction.isButton()) {
        return;
      }

      // Discord potřebuje rychlé potvrzení
      await interaction.deferUpdate();

      const data = loadData();

      const messageId =
        interaction.message.id;

      const poll =
        data.polls[messageId];

      if (!poll) {
        console.log(
          `Pro tuto anketu nejsou uložena data. Message ID: ${messageId}`
        );

        return;
      }

      poll.attendance =
        normalizeAttendance(
          poll.attendance
        );

      if (poll.locked) {
        return;
      }

      const day =
        interaction.customId.replace(
          "day_",
          ""
        );

      const userId =
        interaction.user.id;

      if (!DAYS.includes(day)) {
        return;
      }

      const people =
        poll.attendance[day] || [];


      // -------------------------------------------------
      // UŽ JE PŘIHLÁŠEN → ODHLÁSIT JEN Z TOHOTO DNE
      // -------------------------------------------------

      if (
        people.includes(userId)
      ) {
        poll.attendance[day] =
          people.filter(
            id => id !== userId
          );
      }


      // -------------------------------------------------
      // NENÍ PŘIHLÁŠEN → PŘIHLÁSIT JEN NA TENTO DEN
      // -------------------------------------------------

      else {
        if (
          people.length >=
          CAPACITY
        ) {
          return;
        }

        poll.attendance[day] = [
          ...people,
          userId
        ];
      }


      // -------------------------------------------------
      // ULOŽIT
      // -------------------------------------------------

      data.polls[messageId] =
        poll;

      saveData(data);


      // -------------------------------------------------
      // AKTUALIZOVAT DISCORD
      // -------------------------------------------------

      await interaction.message.edit({
        embeds: [
          createEmbed(poll)
        ],

        components:
          createButtons(poll)
      });

    } catch (error) {
      console.error(
        "Chyba při Discord interakci:"
      );

      console.error(error);
    }
  }
);


// =====================================================
// DISCORD CHYBY
// =====================================================

client.on(
  Events.Error,
  error => {
    console.error(
      "Discord Client Error:"
    );

    console.error(error);
  }
);


// =====================================================
// DALŠÍ CHYBY
// =====================================================

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "UNHANDLED REJECTION:"
    );

    console.error(error);
  }
);


process.on(
  "uncaughtException",
  error => {
    console.error(
      "UNCAUGHT EXCEPTION:"
    );

    console.error(error);
  }
);


// =====================================================
// START WEB SERVERU
// =====================================================

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  () => {
    console.log(
      `Web server běží na portu ${PORT}.`
    );
  }
);


// =====================================================
// START DISCORDU
// =====================================================

async function startDiscord() {
  try {
    console.log(
      "Spouštím přihlášení k Discordu..."
    );

    if (!TOKEN) {
      throw new Error(
        "DISCORD_TOKEN není nastaven."
      );
    }

    await client.login(TOKEN);

    console.log(
      "client.login() proběhl úspěšně."
    );

  } catch (error) {
    console.error(
      "======================================"
    );

    console.error(
      "CHYBA PŘI PŘIHLÁŠENÍ K DISCORDU:"
    );

    console.error(error);

    console.error(
      "======================================"
    );
  }
}


startDiscord();
