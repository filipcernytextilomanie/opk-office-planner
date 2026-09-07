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
const cron = require("node-cron");

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

// Ochrana proti souběžnému vytváření / uzavírání ankety
let sendPollPromise = null;
let lockPollPromise = null;

// Fronta pro hlasování v jednotlivých anketách
const pollQueues = new Map();


// ======================================================
// ČAS V PRAZE
// ======================================================

function getPragueNow() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });

  const parts = formatter.formatToParts(now);

  const get = type =>
    parts.find(p => p.type === type)?.value;

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    weekday: weekdayMap[get("weekday")],
    hour: Number(get("hour")),
    minute: Number(get("minute"))
  };
}


function getPragueDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(new Date());

  const get = type =>
    Number(parts.find(p => p.type === type).value);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day")
  };
}


function getPragueWeekday() {
  return getPragueNow().weekday;
}


function formatUTCDate(date) {
  const dd = String(
    date.getUTCDate()
  ).padStart(2, "0");

  const mm = String(
    date.getUTCMonth() + 1
  ).padStart(2, "0");

  const yyyy =
    date.getUTCFullYear();

  return `${dd}.${mm}.${yyyy}`;
}


function getNextWeekDays() {
  const p =
    getPragueDateParts();

  const weekday =
    getPragueWeekday();

  // Poledne chrání výpočet před problémy se změnou času
  const today = new Date(
    Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      12,
      0,
      0
    )
  );

  const daysUntilMonday =
    ((8 - weekday) % 7) || 7;

  const monday =
    new Date(today);

  monday.setUTCDate(
    monday.getUTCDate() +
    daysUntilMonday
  );

  return DAYS.map(
    (name, index) => {

      const date =
        new Date(monday);

      date.setUTCDate(
        monday.getUTCDate() +
        index
      );

      return {
        name,
        shortName:
          SHORT_DAYS[index],
        date:
          formatUTCDate(date)
      };
    }
  );
}


// ======================================================
// DOCHÁZKA
// ======================================================

function createEmptyAttendance() {
  const attendance = {};

  DAYS.forEach(day => {
    attendance[day] = [];
  });

  return attendance;
}


function normalizeAttendance(attendance) {
  const normalized =
    createEmptyAttendance();

  DAYS.forEach(day => {
    if (
      Array.isArray(
        attendance?.[day]
      )
    ) {
      normalized[day] = [
        ...new Set(
          attendance[day]
        )
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
    normalizeAttendance(
      poll.attendance
    );

  const weekStart =
    poll.days[0].date;

  const weekEnd =
    poll.days[4].date;

  const embed =
    new EmbedBuilder()

      .setTitle(
        poll.locked
          ? "Přítomnost v kanceláři OPK – UZAVŘENO"
          : "Přítomnost v kanceláři OPK"
      )

      .setDescription(
        `**Týden ${weekStart} – ${weekEnd}**`
      );

  poll.days.forEach(
    dayInfo => {

      const people =
        poll.attendance[
          dayInfo.name
        ] || [];

      const value =
        people.length

          ? people
              .map(
                id =>
                  `• <@${id}>`
              )
              .join("\n")

          : "_Nikdo přihlášen_";

      embed.addFields({
        name:
          `${dayInfo.name} / ` +
          `${dayInfo.shortName} ` +
          `${dayInfo.date} ` +
          `(${people.length}/${CAPACITY})`,

        value,
        inline: false
      });
    }
  );

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
    normalizeAttendance(
      poll.attendance
    );

  const row =
    new ActionRowBuilder();

  poll.days.forEach(
    (dayInfo, index) => {

      const people =
        poll.attendance[
          dayInfo.name
        ] || [];

      row.addComponents(

        new ButtonBuilder()

          .setCustomId(
            `opk_day_${index}`
          )

          .setLabel(
            `${dayInfo.shortName} ` +
            `${dayInfo.date} ` +
            `(${people.length}/${CAPACITY})`
          )

          .setStyle(
            ButtonStyle.Primary
          )

          // Při 9/9 tlačítko NEVYPÍNÁME,
          // protože již přihlášený člověk se musí umět odhlásit.
          .setDisabled(
            poll.locked
          )
      );
    }
  );

  return [row];
}


// ======================================================
// NAČTENÍ ANKETY Z DISCORD ZPRÁVY
// ======================================================

function parsePollFromMessage(message) {
  const embed =
    message.embeds?.[0];

  if (!embed) {
    return null;
  }

  const locked =
    embed.title?.includes(
      "UZAVŘENO"
    ) || false;

  const attendance =
    createEmptyAttendance();

  const days = [];

  for (
    let i = 0;
    i < embed.fields.length;
    i++
  ) {
    const field =
      embed.fields[i];

    const match =
      field.name.match(
        /^(Pondělí|Úterý|Středa|Čtvrtek|Pátek)\s*\/\s*(Po|Út|St|Čt|Pá)\s+(\d{2}\.\d{2}\.\d{4})\s+\((\d+)\/9\)$/
      );

    if (!match) {
      continue;
    }

    const dayName =
      match[1];

    const shortName =
      match[2];

    const date =
      match[3];

    days.push({
      name: dayName,
      shortName,
      date
    });

    const ids = [
      ...field.value.matchAll(
        /<@!?(\d+)>/g
      )
    ].map(
      result =>
        result[1]
    );

    attendance[
      dayName
    ] = [
      ...new Set(ids)
    ];
  }

  if (
    days.length !== 5
  ) {
    return null;
  }

  return {
    locked,
    days,
    attendance
  };
}


// ======================================================
// KANÁL
// ======================================================

async function getChannel() {
  const channel =
    await client.channels.fetch(
      CHANNEL_ID
    );

  if (!channel) {
    throw new Error(
      "Discord kanál nebyl nalezen."
    );
  }

  if (
    !channel.isTextBased()
  ) {
    throw new Error(
      "CHANNEL_ID nepatří textovému kanálu."
    );
  }

  return channel;
}


// ======================================================
// NAJÍT EXISTUJÍCÍ ANKETY
// ======================================================

async function findPollForNextWeek() {
  const channel =
    await getChannel();

  const expectedDays =
    getNextWeekDays();

  const expectedText =
    `Týden ` +
    `${expectedDays[0].date} – ` +
    `${expectedDays[4].date}`;

  const messages =
    await channel.messages.fetch({
      limit: 100
    });

  return (
    messages.find(
      message => {

        if (
          message.author.id !==
          client.user.id
        ) {
          return false;
        }

        const embed =
          message.embeds?.[0];

        if (!embed) {
          return false;
        }

        // Počítá i již uzavřenou anketu,
        // aby nevznikla druhá.
        return (
          embed.title?.startsWith(
            "Přítomnost v kanceláři OPK"
          ) &&
          embed.description
            ?.includes(
              expectedText
            )
        );
      }
    ) || null
  );
}


async function findLatestOpenPoll() {
  const channel =
    await getChannel();

  const messages =
    await channel.messages.fetch({
      limit: 100
    });

  return (
    messages.find(
      message => {

        if (
          message.author.id !==
          client.user.id
        ) {
          return false;
        }

        const title =
          message.embeds?.[0]
            ?.title;

        return (
          title ===
          "Přítomnost v kanceláři OPK"
        );
      }
    ) || null
  );
}


// ======================================================
// POČKAT NA DISCORD
// ======================================================

async function waitForDiscord(
  timeoutSeconds = 60
) {
  if (
    client.isReady()
  ) {
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
    if (
      client.isReady()
    ) {
      return true;
    }

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          1000
        )
    );
  }

  return false;
}


// ======================================================
// VYTVOŘIT ANKETU – INTERNÍ FUNKCE
// ======================================================

async function doSendPoll() {
  const ready =
    await waitForDiscord();

  if (!ready) {
    throw new Error(
      "Bot není připojen k Discordu."
    );
  }

  const existing =
    await findPollForNextWeek();

  if (existing) {
    console.log(
      `Anketa pro příští týden už existuje. ID: ${existing.id}`
    );

    return {
      message: existing,
      created: false
    };
  }

  const poll = {
    locked: false,
    days:
      getNextWeekDays(),
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
// OCHRANA PROTI DVOJÍMU VYTVOŘENÍ
// ======================================================

async function sendPoll() {
  if (sendPollPromise) {
    console.log(
      "Vytvoření ankety už právě probíhá. Čekám na výsledek."
    );

    return sendPollPromise;
  }

  sendPollPromise =
    doSendPoll()
      .finally(() => {
        sendPollPromise = null;
      });

  return sendPollPromise;
}


// ======================================================
// UZAVŘÍT ANKETU
// ======================================================

async function doLockPoll() {
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
    parsePollFromMessage(
      message
    );

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


async function lockPoll() {
  if (lockPollPromise) {
    return lockPollPromise;
  }

  lockPollPromise =
    doLockPoll()
      .finally(() => {
        lockPollPromise = null;
      });

  return lockPollPromise;
}


// ======================================================
// SERIALIZACE HLASOVÁNÍ
// ======================================================

async function withPollLock(
  messageId,
  task
) {
  const previous =
    pollQueues.get(
      messageId
    ) || Promise.resolve();

  let release;

  const current =
    new Promise(resolve => {
      release = resolve;
    });

  pollQueues.set(
    messageId,
    previous.then(
      () => current
    )
  );

  await previous;

  try {
    return await task();
  } finally {
    release();

    setTimeout(() => {
      if (
        pollQueues.get(
          messageId
        ) === current
      ) {
        pollQueues.delete(
          messageId
        );
      }
    }, 1000);
  }
}


// ======================================================
// ZÁLOŽNÍ KONTROLA ČASU
// ======================================================

async function runSafetyCheck(
  source = "SAFETY"
) {
  try {
    if (
      !client.isReady()
    ) {
      console.log(
        `${source}: Discord není online, kontrolu přeskakuji.`
      );

      return;
    }

    const now =
      getPragueNow();

    // Jen pátek
    if (
      now.weekday !== 5
    ) {
      return;
    }

    // --------------------------------------------------
    // 08:00–09:00:
    // nejpozději v tomto okně má anketa vzniknout
    // --------------------------------------------------

    if (
      now.hour === 8 ||
      (
        now.hour === 9 &&
        now.minute === 0
      )
    ) {
      const existing =
        await findPollForNextWeek();

      if (!existing) {
        console.warn(
          `${source}: Anketa chybí v ${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")} – vytvářím ji nyní.`
        );

        await sendPoll();
      }

      return;
    }


    // --------------------------------------------------
    // PO 09:00 A PŘED 16:00
    // POSLEDNÍ NOUZOVÁ POJISTKA
    // --------------------------------------------------

    if (
      now.hour > 9 &&
      now.hour < 16
    ) {
      const existing =
        await findPollForNextWeek();

      if (!existing) {
        console.error(
          `${source}: Anketa stále neexistuje po 09:00. Nouzově ji vytvářím.`
        );

        await sendPoll();
      }

      return;
    }


    // --------------------------------------------------
    // OD 16:00:
    // pokud je anketa stále otevřená, uzavřít
    // --------------------------------------------------

    if (
      now.hour >= 16
    ) {
      const openPoll =
        await findLatestOpenPoll();

      if (openPoll) {
        console.warn(
          `${source}: Po 16:00 je stále otevřená anketa. Uzavírám ji.`
        );

        await lockPoll();
      }
    }

  } catch (error) {
    console.error(
      `${source}: Chyba bezpečnostní kontroly:`,
      error
    );
  }
}


// ======================================================
// WEB
// ======================================================

app.get(
  "/",
  (req, res) => {

    res.status(200).json({
      web: true,
      discordReady:
        client.isReady(),
      discordUser:
        client.user?.tag ||
        null
    });

  }
);


app.get(
  "/status",
  (req, res) => {

    const now =
      getPragueNow();

    res.status(200).json({
      web: true,

      discordReady:
        client.isReady(),

      discordUser:
        client.user?.tag ||
        null,

      pragueTime:
        `${String(now.hour).padStart(2, "0")}:${String(now.minute).padStart(2, "0")}`,

      pragueWeekday:
        now.weekday,

      channelConfigured:
        Boolean(CHANNEL_ID),

      roleConfigured:
        Boolean(OPK_ROLE_ID),

      schedulerConfigured:
        Boolean(SCHEDULER_KEY)
    });

  }
);


// ======================================================
// EXTERNÍ ODESLÁNÍ
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

      return res
        .status(200)
        .send(
          result.created
            ? `Anketa byla vytvořena. ID: ${result.message.id}`
            : `Anketa už existuje. ID: ${result.message.id}`
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
// EXTERNÍ UZAVŘENÍ
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

      return res
        .status(200)
        .send(
          result
            ? "Anketa byla uzavřena."
            : "Nebyla nalezena otevřená anketa."
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


    // --------------------------------------------------
    // SLASH PŘÍKAZY
    // --------------------------------------------------

    try {
      await client.application
        .commands.set([
          {
            name:
              "anketa",

            description:
              "Ručně vytvoří anketu přítomnosti OPK."
          },
          {
            name:
              "uzavrit",

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


    // --------------------------------------------------
    // HLAVNÍ CRON 08:00
    // --------------------------------------------------

    cron.schedule(
      "0 8 * * 5",
      async () => {

        console.log(
          "CRON 08:00 – kontroluji anketu."
        );

        try {
          const result =
            await sendPoll();

          console.log(
            result.created
              ? "CRON 08:00 – anketa vytvořena."
              : "CRON 08:00 – anketa už existuje."
          );

        } catch (error) {
          console.error(
            "CRON 08:00 – chyba:",
            error
          );
        }
      },
      {
        timezone:
          TIME_ZONE
      }
    );


    // --------------------------------------------------
    // HLAVNÍ CRON 16:00
    // --------------------------------------------------

    cron.schedule(
      "0 16 * * 5",
      async () => {

        console.log(
          "CRON 16:00 – uzavírám anketu."
        );

        try {
          await lockPoll();

        } catch (error) {
          console.error(
            "CRON 16:00 – chyba:",
            error
          );
        }
      },
      {
        timezone:
          TIME_ZONE
      }
    );


    // --------------------------------------------------
    // ZÁLOŽNÍ KONTROLA KAŽDÝCH 5 MINUT
    // --------------------------------------------------

    cron.schedule(
      "*/5 * * * *",
      async () => {
        await runSafetyCheck(
          "5MIN SAFETY"
        );
      },
      {
        timezone:
          TIME_ZONE
      }
    );


    console.log(
      "Automatika připravena:"
    );

    console.log(
      "- pátek 08:00 hlavní spuštění"
    );

    console.log(
      "- každých 5 minut záložní kontrola"
    );

    console.log(
      "- pátek 16:00 uzavření"
    );


    // --------------------------------------------------
    // KONTROLA IHNED PO STARTU / RESTARTU
    // --------------------------------------------------

    setTimeout(
      async () => {

        console.log(
          "STARTUP SAFETY – kontroluji stav ankety."
        );

        await runSafetyCheck(
          "STARTUP SAFETY"
        );

      },
      5000
    );
  }
);


// ======================================================
// DISCORD INTERAKCE
// ======================================================

client.on(
  Events.InteractionCreate,
  async interaction => {

    try {

      // -------------------------------------------------
      // /ANKETA
      // -------------------------------------------------

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
            content:
              result.created
                ? "Nová anketa byla vytvořena."
                : "Anketa pro příští týden už existuje."
          });

          return;
        }


        // -----------------------------------------------
        // /UZAVRIT
        // -----------------------------------------------

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
            content:
              result
                ? "Anketa byla uzavřena."
                : "Není žádná otevřená anketa."
          });

          return;
        }
      }


      // -------------------------------------------------
      // TLAČÍTKA
      // -------------------------------------------------

      if (
        !interaction.isButton()
      ) {
        return;
      }

      if (
        !interaction.customId
          .startsWith(
            "opk_day_"
          )
      ) {
        return;
      }


      // Discord dostane potvrzení okamžitě
      await interaction.deferUpdate();


      const messageId =
        interaction.message.id;


      await withPollLock(
        messageId,
        async () => {

          // Vždy načíst ČERSTVOU verzi zprávy,
          // aby se neztratily souběžné hlasy.
          const channel =
            await getChannel();

          const freshMessage =
            await channel.messages.fetch(
              messageId
            );

          const poll =
            parsePollFromMessage(
              freshMessage
            );

          if (!poll) {
            console.error(
              "Nepodařilo se načíst anketu z Discord zprávy."
            );

            return;
          }

          if (
            poll.locked
          ) {
            return;
          }

          const dayIndex =
            Number(
              interaction.customId
                .replace(
                  "opk_day_",
                  ""
                )
            );

          if (
            !Number.isInteger(
              dayIndex
            ) ||
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
            poll.attendance[
              dayName
            ] || [];


          // ---------------------------------------------
          // ODHLÁŠENÍ
          // ---------------------------------------------

          if (
            people.includes(
              userId
            )
          ) {

            poll.attendance[
              dayName
            ] =
              people.filter(
                id =>
                  id !== userId
              );
          }


          // ---------------------------------------------
          // PŘIHLÁŠENÍ
          // ---------------------------------------------

          else {

            if (
              people.length >=
              CAPACITY
            ) {

              await interaction.followUp({
                content:
                  `${dayName} už má plnou kapacitu ${CAPACITY}/${CAPACITY}.`,
                ephemeral: true
              });

              return;
            }

            poll.attendance[
              dayName
            ] = [
              ...people,
              userId
            ];
          }


          // OSTATNÍ DNY SE NEMĚNÍ


          await freshMessage.edit({
            embeds: [
              createEmbed(poll)
            ],

            components:
              createButtons(poll)
          });
        }
      );

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
  process.env.PORT ||
  3000;

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
