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

const app = express();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPK_ROLE_ID = process.env.OPK_ROLE_ID;
const SCHEDULER_KEY = process.env.SCHEDULER_KEY;

const CAPACITY = 9;
const TIME_ZONE = "Europe/Prague";

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


// ======================================================
// ČAS / DATUM
// ======================================================

function getPragueDateParts() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(now);

  const get = type =>
    Number(parts.find(p => p.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day")
  };
}


function getPragueWeekday() {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short"
  }).format(new Date());

  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return map[weekday];
}


function formatUTCDate(date) {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();

  return `${dd}.${mm}.${yyyy}`;
}


function getNextWeekDays() {
  const p = getPragueDateParts();
  const weekday = getPragueWeekday();

  // Počítáme od poledne UTC, aby nás nerozhodilo DST.
  const today = new Date(
    Date.UTC(p.year, p.month - 1, p.day, 12, 0, 0)
  );

  const daysUntilMonday =
    ((8 - weekday) % 7) || 7;

  const monday = new Date(today);
  monday.setUTCDate(
    monday.getUTCDate() + daysUntilMonday
  );

  return DAYS.map((name, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);

    return {
      name,
      shortName: SHORT_DAYS[index],
      date: formatUTCDate(date)
    };
  });
}


// ======================================================
// STAV ANKETY
// ======================================================

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


// ======================================================
// EMBED
// ======================================================

function createEmbed(poll) {
  poll.attendance =
    normalizeAttendance(poll.attendance);

  const weekStart = poll.days[0].date;
  const weekEnd = poll.days[4].date;

  const embed = new EmbedBuilder()
    .setTitle(
      poll.locked
        ? "Přítomnost v kanceláři OPK – UZAVŘENO"
        : "Přítomnost v kanceláři OPK"
    )
    .setDescription(
      `**Týden ${weekStart} – ${weekEnd}**`
    );

  poll.days.forEach(dayInfo => {
    const people =
      poll.attendance[dayInfo.name] || [];

    const value = people.length
      ? people
          .map(id => `• <@${id}>`)
          .join("\n")
      : "_Nikdo přihlášen_";

    embed.addFields({
      name:
        `${dayInfo.name} / ${dayInfo.shortName} ` +
        `${dayInfo.date} (${people.length}/${CAPACITY})`,
      value,
      inline: false
    });
  });

  embed.setFooter({
    text: poll.locked
      ? "Hlasování je uzamčeno. Výsledky zůstávají viditelné."
      : "Kliknutím na den se přihlásíte nebo odhlásíte. Kapacita kanceláře je 9 osob."
  });

  return embed;
}


// ======================================================
// TLAČÍTKA
// ======================================================

function createButtons(poll) {
  poll.attendance =
    normalizeAttendance(poll.attendance);

  const row = new ActionRowBuilder();

  poll.days.forEach((dayInfo, index) => {
    const people =
      poll.attendance[dayInfo.name] || [];

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`opk_day_${index}`)
        .setLabel(
          `${dayInfo.shortName} ${dayInfo.date} ` +
          `(${people.length}/${CAPACITY})`
        )
        .setStyle(ButtonStyle.Primary)
        .setDisabled(
          poll.locked ||
          people.length >= CAPACITY
        )
    );
  });

  return [row];
}


// ======================================================
// NAČTENÍ STAVU Z DISCORD ZPRÁVY
// ======================================================

function parsePollFromMessage(message) {
  const embed = message.embeds?.[0];

  if (!embed) {
    return null;
  }

  const locked =
    embed.title?.includes("UZAVŘENO") || false;

  const attendance =
    createEmptyAttendance();

  const days = [];

  for (let i = 0; i < embed.fields.length; i++) {
    const field = embed.fields[i];

    const match = field.name.match(
      /^(Pondělí|Úterý|Středa|Čtvrtek|Pátek)\s*\/\s*(Po|Út|St|Čt|Pá)\s+(\d{2}\.\d{2}\.\d{4})\s+\((\d+)\/9\)$/
    );

    if (!match) {
      continue;
    }

    const dayName = match[1];
    const shortName = match[2];
    const date = match[3];

    days.push({
      name: dayName,
      shortName,
      date
    });

    const ids = [
      ...field.value.matchAll(/<@!?(\d+)>/g)
    ].map(m => m[1]);

    attendance[dayName] = [
      ...new Set(ids)
    ];
  }

  if (days.length !== 5) {
    return null;
  }

  return {
    locked,
    days,
    attendance
  };
}


// ======================================================
// NAJÍT AKTUÁLNÍ ANKETU
// ======================================================

async function getChannel() {
  const channel =
    await client.channels.fetch(CHANNEL_ID);

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

  return channel;
}


async function findLatestOpenPoll() {
  const channel = await getChannel();

  const messages =
    await channel.messages.fetch({
      limit: 50
    });

  const polls = messages.filter(message => {
    if (message.author.id !== client.user.id) {
      return false;
    }

    const title =
      message.embeds?.[0]?.title;

    return (
      title ===
      "Přítomnost v kanceláři OPK"
    );
  });

  return polls.first() || null;
}


async function findPollForNextWeek() {
  const channel = await getChannel();

  const expectedDays =
    getNextWeekDays();

  const expectedText =
    `Týden ${expectedDays[0].date} – ${expectedDays[4].date}`;

  const messages =
    await channel.messages.fetch({
      limit: 50
    });

  return (
    messages.find(message => {
      if (message.author.id !== client.user.id) {
        return false;
      }

      const embed =
        message.embeds?.[0];

      if (!embed) {
        return false;
      }

      return (
        embed.title ===
          "Přítomnost v kanceláři OPK" &&
        embed.description?.includes(
          expectedText
        )
      );
    }) || null
  );
}


// ======================================================
// POČKAT NA DISCORD
// ======================================================

async function waitForDiscord(
  timeoutSeconds = 90
) {
  if (client.isReady()) {
    return true;
  }

  console.log(
    "Čekám na připojení k Discordu..."
  );

  for (
    let i = 0;
    i < timeoutSeconds;
    i++
  ) {
    if (client.isReady()) {
      return true;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 1000)
    );
  }

  return false;
}


// ======================================================
// VYTVOŘIT ANKETU
// ======================================================

async function sendPoll() {
  const ready =
    await waitForDiscord();

  if (!ready) {
    throw new Error(
      "Bot není připojen k Discordu."
    );
  }

  // Ochrana proti duplicitě
  const existing =
    await findPollForNextWeek();

  if (existing) {
    console.log(
      `Anketa pro tento týden už existuje: ${existing.id}`
    );

    return {
      message: existing,
      created: false
    };
  }

  const poll = {
    locked: false,
    days: getNextWeekDays(),
    attendance:
      createEmptyAttendance()
  };

  const channel =
    await getChannel();

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

  console.log(
    `Anketa byla vytvořena. ID: ${message.id}`
  );

  return {
    message,
    created: true
  };
}


// ======================================================
// UZAVŘÍT ANKETU
// ======================================================

async function lockPoll() {
  const ready =
    await waitForDiscord();

  if (!ready) {
    throw new Error(
      "Bot není připojen k Discordu."
    );
  }

  const message =
    await findLatestOpenPoll();

  if (!message) {
    console.log(
      "Nebyla nalezena otevřená anketa."
    );

    return false;
  }

  const poll =
    parsePollFromMessage(message);

  if (!poll) {
    throw new Error(
      "Nepodařilo se načíst data ankety."
    );
  }

  poll.locked = true;

  await message.edit({
    embeds: [
      createEmbed(poll)
    ],

    components:
      createButtons(poll)
  });

  console.log(
    `Anketa ${message.id} byla uzavřena.`
  );

  return true;
}


// ======================================================
// WEB
// ======================================================

app.get("/", (req, res) => {
  res.status(200).json({
    web: true,
    discordReady:
      client.isReady(),
    discordUser:
      client.user?.tag || null
  });
});


app.get("/status", (req, res) => {
  res.status(200).json({
    web: true,
    discordReady:
      client.isReady(),
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


// ======================================================
// EXTERNÍ SCHEDULER – 08:00
// ======================================================

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

      const result =
        await sendPoll();

      if (result.created) {
        return res
          .status(200)
          .send(
            `Anketa byla vytvořena. ID: ${result.message.id}`
          );
      }

      return res
        .status(200)
        .send(
          `Anketa už existovala. ID: ${result.message.id}`
        );

    } catch (error) {
      console.error(
        "Chyba /send-poll:",
        error
      );

      return res
        .status(500)
        .send(
          "Anketu se nepodařilo vytvořit."
        );
    }
  }
);


// ======================================================
// EXTERNÍ SCHEDULER – 16:00
// ======================================================

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

      const result =
        await lockPoll();

      if (!result) {
        return res
          .status(404)
          .send(
            "Nebyla nalezena otevřená anketa."
          );
      }

      return res
        .status(200)
        .send(
          "Anketa byla uzavřena."
        );

    } catch (error) {
      console.error(
        "Chyba /lock-poll:",
        error
      );

      return res
        .status(500)
        .send(
          "Anketu se nepodařilo uzavřít."
        );
    }
  }
);


// ======================================================
// DISCORD READY
// ======================================================

client.once(
  Events.ClientReady,
  async readyClient => {
    console.log(
      `DISCORD ONLINE: ${readyClient.user.tag}`
    );

    try {
      await client.application.commands.set([
        {
          name: "anketa",
          description:
            "Ručně vytvoří anketu přítomnosti OPK."
        },
        {
          name: "uzavrit",
          description:
            "Ručně uzavře aktuální anketu OPK."
        }
      ]);

      console.log(
        "Příkazy /anketa a /uzavrit jsou připravené."
      );

    } catch (error) {
      console.error(
        "Chyba registrace příkazů:",
        error
      );
    }
  }
);


// ======================================================
// DISCORD INTERAKCE
// ======================================================

client.on(
  Events.InteractionCreate,
  async interaction => {
    try {

      // -----------------------------------------------
      // /ANKETA
      // -----------------------------------------------

      if (
        interaction.isChatInputCommand()
      ) {

        if (
          interaction.commandName ===
          "anketa"
        ) {
          await interaction.deferReply({
            ephemeral: true
          });

          const result =
            await sendPoll();

          await interaction.editReply({
            content: result.created
              ? "Nová anketa byla vytvořena."
              : "Anketa pro příští týden už existuje."
          });

          return;
        }


        // ---------------------------------------------
        // /UZAVRIT
        // ---------------------------------------------

        if (
          interaction.commandName ===
          "uzavrit"
        ) {
          await interaction.deferReply({
            ephemeral: true
          });

          const result =
            await lockPoll();

          await interaction.editReply({
            content: result
              ? "Anketa byla uzavřena."
              : "Není žádná otevřená anketa."
          });

          return;
        }
      }


      // -----------------------------------------------
      // TLAČÍTKA
      // -----------------------------------------------

      if (!interaction.isButton()) {
        return;
      }

      // Toto musí být úplně první.
      await interaction.deferUpdate();

      if (
        !interaction.customId.startsWith(
          "opk_day_"
        )
      ) {
        return;
      }

      const poll =
        parsePollFromMessage(
          interaction.message
        );

      if (!poll) {
        console.error(
          "Nepodařilo se načíst anketu z Discord zprávy."
        );

        return;
      }

      if (poll.locked) {
        return;
      }

      const dayIndex =
        Number(
          interaction.customId.replace(
            "opk_day_",
            ""
          )
        );

      if (
        !Number.isInteger(dayIndex) ||
        dayIndex < 0 ||
        dayIndex > 4
      ) {
        return;
      }

      const dayName =
        DAYS[dayIndex];

      const userId =
        interaction.user.id;

      const people =
        poll.attendance[dayName] || [];


      // -----------------------------------------------
      // ODHLÁŠENÍ Z JEDNOHO DNE
      // -----------------------------------------------

      if (
        people.includes(userId)
      ) {
        poll.attendance[dayName] =
          people.filter(
            id => id !== userId
          );
      }


      // -----------------------------------------------
      // PŘIHLÁŠENÍ NA JEDEN DEN
      // -----------------------------------------------

      else {
        if (
          people.length >=
          CAPACITY
        ) {
          return;
        }

        poll.attendance[dayName] = [
          ...people,
          userId
        ];
      }


      // Ostatní dny zůstávají beze změny.

      await interaction.message.edit({
        embeds: [
          createEmbed(poll)
        ],

        components:
          createButtons(poll)
      });

    } catch (error) {
      console.error(
        "Chyba Discord interakce:",
        error
      );
    }
  }
);


// ======================================================
// CHYBY
// ======================================================

client.on(
  Events.Error,
  error => {
    console.error(
      "Discord chyba:",
      error
    );
  }
);


process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);


process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);


// ======================================================
// WEB SERVER
// ======================================================

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


// ======================================================
// DISCORD LOGIN
// ======================================================

if (!TOKEN) {
  console.error(
    "DISCORD_TOKEN není nastaven."
  );
} else {
  console.log(
    "Připojuji Discord bota..."
  );

  client.login(TOKEN)
    .catch(error => {
      console.error(
        "Discord login selhal:",
        error
      );
    });
}
