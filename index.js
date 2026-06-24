const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const cron = require("node-cron");
const express = require("express");

const app = express();
app.get("/", (req, res) => res.send("OPK bot běží."));
app.listen(process.env.PORT || 3000, () => console.log("Web server běží."));

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const OPK_ROLE_ID = process.env.OPK_ROLE_ID || "934064542760189983";

const CAPACITY = 9;
const DAYS = ["Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek"];
const SHORT_DAYS = ["Po", "Út", "St", "Čt", "Pá"];

let lastPollMessageId = null;

function getNextWeekDays() {
  const today = new Date();
  const day = today.getDay();
  const daysUntilNextMonday = ((8 - day) % 7) || 7;

  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilNextMonday);

  return DAYS.map((dayName, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);

    return {
      name: dayName,
      shortName: SHORT_DAYS[index],
      date: date.toLocaleDateString("cs-CZ", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
      })
    };
  });
}

function createEmptyAttendance() {
  const attendance = {};
  DAYS.forEach(day => attendance[day] = []);
  return attendance;
}

function parseAttendanceFromEmbed(embed) {
  const attendance = createEmptyAttendance();

  if (!embed || !embed.description) return attendance;

  DAYS.forEach(day => {
    const index = DAYS.indexOf(day);
    const shortDay = SHORT_DAYS[index];

    const regex = new RegExp(
      `\\*\\*${day} / ${shortDay} [^\\n]*\\*\\*\\n([\\s\\S]*?)(?=\\n\\n\\*\\*|$)`,
      "m"
    );

    const match = embed.description.match(regex);

    if (match && match[1]) {
      const ids = [...match[1].matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
      attendance[day] = ids;
    }
  });

  return attendance;
}

function createEmbed(attendance, locked = false) {
  const nextWeekDays = getNextWeekDays();
  const weekStart = nextWeekDays[0].date;
  const weekEnd = nextWeekDays[4].date;

  const description = nextWeekDays.map(dayInfo => {
    const people = attendance[dayInfo.name] || [];

    const list = people.length
      ? people.map(id => `• <@${id}>`).join("\n")
      : "_Nikdo přihlášen_";

    return `**${dayInfo.name} / ${dayInfo.shortName} ${dayInfo.date} (${people.length}/${CAPACITY})**\n${list}`;
  }).join("\n\n");

  return new EmbedBuilder()
    .setTitle(locked ? "Přítomnost v kanceláři OPK – UZAVŘENO" : "Přítomnost v kanceláři OPK")
    .setDescription(`**Týden ${weekStart} – ${weekEnd}**\n\n${description}`)
    .setFooter({
      text: locked
        ? "Hlasování je uzamčeno. Výsledky zůstávají viditelné."
        : "Anketa je otevřená v pátek od 8:00 do 16:00. Kliknutím na den se přihlásíte nebo odhlásíte."
    });
}

function createButtons(attendance, locked = false) {
  const row = new ActionRowBuilder();
  const nextWeekDays = getNextWeekDays();

  nextWeekDays.forEach(dayInfo => {
    const people = attendance[dayInfo.name] || [];
    const isFull = people.length >= CAPACITY;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`day_${dayInfo.name}`)
        .setLabel(`${dayInfo.shortName} ${dayInfo.date} (${people.length}/${CAPACITY})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(locked || isFull)
    );
  });

  return [row];
}

async function sendPoll() {
  const attendance = createEmptyAttendance();
  const channel = await client.channels.fetch(CHANNEL_ID);

  const message = await channel.send({
    content: `<@&${OPK_ROLE_ID}> 📅 Prosím vyplňte přítomnost v kanceláři na příští týden.`,
    embeds: [createEmbed(attendance, false)],
    components: createButtons(attendance, false),
    allowedMentions: {
      roles: [OPK_ROLE_ID]
    }
  });

  lastPollMessageId = message.id;
  console.log("Anketa byla odeslána.");
}

async function lockPoll() {
  if (!lastPollMessageId) {
    console.log("Není uložená žádná aktuální anketa k uzamčení.");
    return;
  }

  const channel = await client.channels.fetch(CHANNEL_ID);
  const message = await channel.messages.fetch(lastPollMessageId);

  const attendance = parseAttendanceFromEmbed(message.embeds[0]);

  await message.edit({
    embeds: [createEmbed(attendance, true)],
    components: createButtons(attendance, true)
  });

  console.log("Anketa byla uzamčena.");
}

client.once("ready", async () => {
  console.log(`Bot je přihlášen jako ${client.user.tag}`);

  await client.application.commands.set([
    {
      name: "anketa",
      description: "Ručně vytvoří novou anketu přítomnosti v kanceláři OPK."
    },
    {
      name: "uzavrit",
      description: "Ručně uzavře poslední vytvořenou anketu OPK."
    }
  ]);

  console.log("Příkazy /anketa a /uzavrit byly zaregistrovány.");

  cron.schedule("0 8 * * 5", sendPoll, {
    timezone: "Europe/Prague"
  });

  cron.schedule("0 16 * * 5", lockPoll, {
    timezone: "Europe/Prague"
  });
});

client.on("interactionCreate", async interaction => {
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
      }

      if (interaction.commandName === "uzavrit") {
        await interaction.reply({
          content: "Uzavírám poslední vytvořenou anketu...",
          ephemeral: true
        });

        await lockPoll();

        await interaction.editReply({
          content: "Anketa byla uzavřena."
        });
      }

      return;
    }

    if (!interaction.isButton()) return;

    await interaction.deferUpdate();

    const message = interaction.message;
    const embed = message.embeds[0];

    const isLocked = embed?.title?.includes("UZAVŘENO");

    if (isLocked) {
      return;
    }

    const day = interaction.customId.replace("day_", "");
    const userId = interaction.user.id;

    if (!DAYS.includes(day)) return;

    const attendance = parseAttendanceFromEmbed(embed);

    if (!attendance[day]) {
      attendance[day] = [];
    }

    const people = attendance[day];

    if (people.includes(userId)) {
      attendance[day] = people.filter(id => id !== userId);
    } else {
      if (people.length >= CAPACITY) {
        return;
      }

      attendance[day].push(userId);
    }

    await message.edit({
      embeds: [createEmbed(attendance, false)],
      components: createButtons(attendance, false)
    });
  } catch (error) {
    console.error("Chyba při interakci:", error);
  }
});

client.on("error", error => {
  console.error("Chyba klienta:", error);
});

process.on("unhandledRejection", error => {
  console.error("Neošetřená chyba:", error);
});

client.login(TOKEN);
