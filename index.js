const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
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
const OPK_ROLE_ID = process.env.OPK_ROLE_ID || "934064542760189983";
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
// DATA
// =====================================================

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return {
        currentPollMessageId: null,
        polls: {}
      };
    }

    return JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );

  } catch (error) {
    console.error(
      "Chyba při načítání data.json:",
      error
    );

    return {
      currentPollMessageId: null,
      polls: {}
    };
  }
}


function saveData(data) {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}


// =====================================================
// DATUMY
// =====================================================

function getNextWeekDays() {

  const today = new Date();

  const day = today.getDay();

  const daysUntilNextMonday =
    ((8 - day) % 7) || 7;

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

  const normalized =
    createEmptyAttendance();

  DAYS.forEach(day => {

    if (
      Array.isArray(
        attendance?.[day]
      )
    ) {

      normalized[day] =
        [...new Set(attendance[day])];

    }

  });

  return normalized;
}


// =====================================================
// EMBED
// =====================================================

function createEmbed(poll) {

  poll.attendance =
    normalizeAttendance(
      poll.attendance
    );

  const weekStart =
    poll.days[0].date;

  const weekEnd =
    poll.days[4].date;


  const description =
    poll.days
      .map(dayInfo => {

        const people =
          poll.attendance[
            dayInfo.name
          ] || [];

        const list =
          people.length

            ? people
                .map(
                  id =>
                    `• <@${id}>`
                )
                .join("\n")

            : "_Nikdo přihlášen_";


        return (
          `**${dayInfo.name} / ` +
          `${dayInfo.shortName} ` +
          `${dayInfo.date} ` +
          `(${people.length}/${CAPACITY})**\n` +
          `${list}`
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

  poll.attendance =
    normalizeAttendance(
      poll.attendance
    );

  const row =
    new ActionRowBuilder();


  poll.days.forEach(
    dayInfo => {

      const people =
        poll.attendance[
          dayInfo.name
        ] || [];

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
            poll.locked ||
            isFull
          )

      );

    }
  );


  return [row];
}


// =====================================================
// POČKÁNÍ NA DISCORD
// =====================================================

async function waitForDiscord() {

  if (client.isReady()) {
    return true;
  }

  console.log(
    "Čekám na připojení k Discordu..."
  );


  for (
    let i = 0;
    i < 60;
    i++
  ) {

    if (client.isReady()) {

      console.log(
        "Discord je připraven."
      );

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


// =====================================================
// NOVÁ ANKETA
// =====================================================

async function sendPoll() {

  const ready =
    await waitForDiscord();

  if (!ready) {

    throw new Error(
      "Bot není připojen k Discordu."
    );

  }


  const data =
    loadData();


  const poll = {

    locked: false,

    days:
      getNextWeekDays(),

    attendance:
      createEmptyAttendance()

  };


  const channel =
    await client.channels.fetch(
      CHANNEL_ID
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

  data.polls[
    message.id
  ] = poll;


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

  const ready =
    await waitForDiscord();

  if (!ready) {

    throw new Error(
      "Bot není připojen k Discordu."
    );

  }


  const data =
    loadData();

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


  data.polls[
    messageId
  ] = poll;


  saveData(data);


  console.log(
    "Anketa byla uzamčena."
  );


  return true;
}


// =====================================================
// WEB SERVER
// =====================================================

app.get(
  "/",
  (req, res) => {

    res.status(200).send(
      "OPK bot běží."
    );

  }
);


// =====================================================
// EXTERNÍ ODESLÁNÍ
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


      res.status(200).send(
        `Anketa byla vytvořena. ID: ${messageId}`
      );


    } catch (error) {

      console.error(
        "Chyba /send-poll:",
        error
      );


      res
        .status(500)
        .send(
          "Anketu se nepodařilo vytvořit."
        );

    }

  }
);


// =====================================================
// EXTERNÍ UZAVŘENÍ
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


      const result =
        await lockPoll();


      if (!result) {

        return res
          .status(404)
          .send(
            "Nebyla nalezena žádná anketa."
          );

      }


      res
        .status(200)
        .send(
          "Anketa byla uzavřena."
        );


    } catch (error) {

      console.error(
        "Chyba /lock-poll:",
        error
      );


      res
        .status(500)
        .send(
          "Anketu se nepodařilo uzavřít."
        );

    }

  }
);


// =====================================================
// DISCORD START
// =====================================================

client.once(
  "ready",
  async () => {

    console.log(
      `Bot je přihlášen jako ${client.user.tag}`
    );


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

  }
);


// =====================================================
// DISCORD INTERAKCE
// =====================================================

client.on(
  "interactionCreate",
  async interaction => {

    try {

      // ===============================================
      // /ANKETA
      // ===============================================

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


        // =============================================
        // /UZAVRIT
        // =============================================

        if (
          interaction.commandName ===
          "uzavrit"
        ) {

          await interaction.reply({

            content:
              "Uzavírám aktuální anketu...",

            ephemeral: true

          });


          await lockPoll();


          await interaction.editReply({

            content:
              "Anketa byla uzavřena."

          });


          return;
        }

      }


      // ===============================================
      // TLAČÍTKA
      // ===============================================

      if (
        !interaction.isButton()
      ) {

        return;

      }


      // Discord musí dostat odpověď co nejrychleji
      await interaction.deferUpdate();


      const data =
        loadData();

      const messageId =
        interaction.message.id;


      if (
        !data.polls[
          messageId
        ]
      ) {

        console.log(
          `Pro tuto anketu nejsou data. Message ID: ${messageId}`
        );

        return;
      }


      const poll =
        data.polls[
          messageId
        ];


      poll.attendance =
        normalizeAttendance(
          poll.attendance
        );


      if (
        poll.locked
      ) {

        return;

      }


      const day =
        interaction.customId.replace(
          "day_",
          ""
        );


      const userId =
        interaction.user.id;


      if (
        !DAYS.includes(day)
      ) {

        return;

      }


      const people =
        poll.attendance[
          day
        ] || [];


      // ===============================================
      // ODHLÁŠENÍ
      // ===============================================

      if (
        people.includes(
          userId
        )
      ) {

        poll.attendance[
          day
        ] =
          people.filter(
            id =>
              id !== userId
          );

      }


      // ===============================================
      // PŘIHLÁŠENÍ
      // ===============================================

      else {

        if (
          people.length >=
          CAPACITY
        ) {

          return;

        }


        poll.attendance[
          day
        ] = [
          ...people,
          userId
        ];

      }


      data.polls[
        messageId
      ] = poll;


      saveData(data);


      await interaction.message.edit({

        embeds: [
          createEmbed(poll)
        ],

        components:
          createButtons(poll)

      });


    } catch (error) {

      console.error(
        "Chyba při interakci:",
        error
      );

    }

  }
);


// =====================================================
// CHYBY
// =====================================================

client.on(
  "error",
  error => {

    console.error(
      "Chyba Discord klienta:",
      error
    );

  }
);


process.on(
  "unhandledRejection",
  error => {

    console.error(
      "Neošetřená chyba:",
      error
    );

  }
);


// =====================================================
// SERVER START
// =====================================================

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


client.login(TOKEN);
