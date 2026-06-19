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

let attendance = {};
let pollMessage = null;
let locked = false;

function resetAttendance() {
  attendance = {};
  DAYS.forEach(day => attendance[day] = []);
  locked = false;
}

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

function createEmbed() {
  const nextWeekDays = getNextWeekDays();
  const weekStart = nextWeekDays[0].date;
  const weekEnd = nextWeekDays[4].date;

  const description = nextWeekDays.map(dayInfo => {
    if (!attendance[dayInfo.name]) attendance[dayInfo.name] = [];

    const people = attendance[dayInfo.name];

    const list = people.length
      ? people.map(id => `• <@${id}>`).join("\n")
      : "_Nikdo přihlášen_";

    return `**${dayInfo.shortName} ${dayInfo.date} (${people.length}/${CAPACITY})**\n${list}`;
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

function createButtons() {
  const row = new ActionRowBuilder();
  const nextWeekDays = getNextWeekDays();

  nextWeekDays.forEach(dayInfo => {
    if (!attendance[dayInfo.name]) attendance[dayInfo.name] = [];

    const isFull = attendance[dayInfo.name].length >= CAPACITY;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`day_${dayInfo.name}`)
        .setLabel(`${dayInfo.shortName} ${dayInfo.date} (${attendance[dayInfo.name].length}/${CAPACITY})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(locked || isFull)
    );
  });

  return [row];
}

async function sendPoll() {
  resetAttendance();

  const channel = await client.channels.fetch(CHANNEL_ID);

  pollMessage = await channel.send({
    content: `<@&${OPK_ROLE_ID}> 📅 Prosím vyplňte přítomnost v kanceláři na příští týden.`,
    embeds: [createEmbed()],
    components: createButtons(),
    allowedMentions: {
      roles: [OPK_ROLE_ID]
    }
  });

  console.log("Anketa byla odeslána.");
}

async function lockPoll() {
  if (!pollMessage) {
    console.log("Není co uzamknout.");
    return;
  }

  locked = true;

  await pollMessage.edit({
    embeds: [createEmbed()],
    components: createButtons()
  });

  console.log("Anketa byla uzamčena.");
}

client.once("ready", async () => {
  console.log(`Bot je přihlášen jako ${client.user.tag}`);

  await sendPoll();

  cron.schedule("0 8 * * 5", sendPoll, {
    timezone: "Europe/Prague"
  });

  cron.schedule("0 16 * * 5", lockPoll, {
    timezone: "Europe/Prague"
  });
});

client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.isButton()) return;

    if (locked) {
      await interaction.reply({
        content: "Hlasování už je uzamčeno.",
        ephemeral: true
      });
      return;
    }

    const day = interaction.customId.replace("day_", "");
    const userId = interaction.user.id;

    if (!DAYS.includes(day)) return;

    if (!attendance[day]) {
      attendance[day] = [];
    }

    const people = attendance[day];

    if (people.includes(userId)) {
      attendance[day] = people.filter(id => id !== userId);
    } else {
      if (people.length >= CAPACITY) {
        await interaction.reply({
          content: `${day} už má plnou kapacitu.`,
          ephemeral: true
        });
        return;
      }

      attendance[day].push(userId);
    }

    await interaction.update({
      embeds: [createEmbed()],
      components: createButtons()
    });
  } catch (error) {
    console.error("Chyba při kliknutí na tlačítko:", error);
  }
});

client.on("error", error => {
  console.error("Chyba klienta:", error);
});

process.on("unhandledRejection", error => {
  console.error("Neošetřená chyba:", error);
});

client.login(TOKEN);
