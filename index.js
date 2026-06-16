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

const CAPACITY = 9;
const DAYS = ["Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek"];

let attendance = {};
let pollMessage = null;
let locked = false;

function resetAttendance() {
  attendance = {};
  DAYS.forEach(day => attendance[day] = []);
  locked = false;
}

function createEmbed() {
  const description = DAYS.map(day => {
    const people = attendance[day];

    const list = people.length
      ? people.map(id => `• <@${id}>`).join("\n")
      : "_Nikdo přihlášen_";

    return `**${day} (${people.length}/${CAPACITY})**\n${list}`;
  }).join("\n\n");

  return new EmbedBuilder()
    .setTitle(locked ? "Přítomnost v kanceláři OPK – UZAVŘENO" : "Přítomnost v kanceláři OPK")
    .setDescription(description)
    .setFooter({
      text: locked
        ? "Hlasování je uzamčeno. Výsledky zůstávají viditelné."
        : "Kliknutím na den se přihlásíte nebo odhlásíte."
    });
}

function createButtons() {
  const row = new ActionRowBuilder();

  DAYS.forEach(day => {
    const isFull = attendance[day].length >= CAPACITY;

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`day_${day}`)
        .setLabel(`${day} (${attendance[day].length}/${CAPACITY})`)
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
    embeds: [createEmbed()],
    components: createButtons()
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

  // TEST - po spuštění hned pošle anketu
  await sendPoll();

  // Každý pátek v 8:00
  cron.schedule("0 8 * * 5", sendPoll, {
    timezone: "Europe/Prague"
  });

  // Každý pátek v 16:00
  cron.schedule("0 16 * * 5", lockPoll, {
    timezone: "Europe/Prague"
  });
});

client.on("interactionCreate", async interaction => {
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
});

client.login(TOKEN);
