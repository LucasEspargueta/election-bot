import { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import fs from 'fs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ]
});

const TEST_GUILD_ID = process.env.GUILD_ID;

let data = {
  registeredCandidates: [],
  currentElection: null
};

try {
  const rawData = fs.readFileSync('data.json');
  data = JSON.parse(rawData);
} catch (error) {
  console.log('Starting with fresh data');
}

function saveData() {
  fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
}

function buildVoteCommand() {
  const voteCommand = new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Rank candidates by preference (1st choice gets most points)');

  //Adds dynamic number of choice fields based on registered candidates
  for (let i = 1; i <= data.registeredCandidates.length; i++) {
    voteCommand.addStringOption(option =>
      option.setName(`choice_${i}`)
        .setDescription(i === 1 ? 'Your first choice' : `Your ${i}${i === 2 ? 'nd' : i === 3 ? 'rd' : 'th'} choice`)
        .setAutocomplete(true)
        .setRequired(i === 1)); //Only first choice is required
  }

  return voteCommand;
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('register')
      .setDescription('Register as a candidate'),
    buildVoteCommand(),
    new SlashCommandBuilder()
      .setName('election')
      .setDescription('Manage elections')
      .addSubcommand(subcommand =>
        subcommand.setName('start')
          .setDescription('Start new election'))
      .addSubcommand(subcommand =>
        subcommand.setName('end')
          .setDescription('End current election'))
      .addSubcommand(subcommand =>
        subcommand.setName('results')
          .setDescription('Show election results'))
  ];

  try {
    const testGuild = await client.guilds.fetch(TEST_GUILD_ID);
    await testGuild.commands.set(commands);
    console.log(`Commands registered in test guild: ${testGuild.name}`);

    await client.application.commands.set(commands);
    console.log('Global commands registered');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    if (!data.currentElection?.isActive || !data.currentElection.candidates.length) {
      return interaction.respond([]);
    }

    const focusedOption = interaction.options.getFocused(true);
    const choices = data.currentElection.candidates
      .map(id => ({ name: `@${client.users.cache.get(id)?.username || id}`, value: id }))
      .filter(choice => 
        choice.name.toLowerCase().includes(focusedOption.value.toLowerCase())
      );

    await interaction.respond(choices.slice(0, 25));
    return;
  }

  if (!interaction.isCommand()) return;

  const { commandName, options, user, member } = interaction;

  try {
    switch(commandName) {
      case 'register':
        if (data.registeredCandidates.includes(user.id)) {
          return interaction.reply({ content: 'You are already registered!', ephemeral: false });
        }
        data.registeredCandidates.push(user.id);
        saveData();
        return interaction.reply({ content: 'You are now registered as a candidate!', ephemeral: false });

      case 'vote':
        if (!data.currentElection?.isActive) {
          return interaction.reply({ content: 'No active election!', ephemeral: true });
        }
        if (data.currentElection.votes.some(v => v.voter === user.id)) {
          return interaction.reply({ content: 'You already voted!', ephemeral: true });
        }

        //Get all provided choices in order (filter out empty ones)
        const choices = [];
        for (let i = 1; i <= 10; i++) {
          const choice = options.getString(`choice_${i}`);
          if (choice) choices.push(choice);
        }

        //Validate all choices are candidates and remove duplicates
        const uniqueChoices = [];
        const invalidChoices = [];
        
        for (const choice of choices) {
          if (data.currentElection.candidates.includes(choice)) {
            if (!uniqueChoices.includes(choice)) {
              uniqueChoices.push(choice);
            }
          } else {
            invalidChoices.push(choice);
          }
        }

        if (invalidChoices.length > 0) {
          return interaction.reply({ 
            content: `Invalid candidates: ${invalidChoices.join(', ')}\nPlease select from the list.`, 
            ephemeral: true 
          });
        }

        if (uniqueChoices.length === 0) {
          return interaction.reply({ 
            content: 'No valid candidates provided!', 
            ephemeral: true 
          });
        }

        //Points are assigned based on the order of choices (1st choice gets number of candidates points, 2nd choice gets number of candidates - 1 points, etc.)
        const maxPoints = data.currentElection.candidates.length;
        const vote = {
          voter: user.id,
          preferences: uniqueChoices,
          points: uniqueChoices.map((candidate, index) => ({
            candidate,
            points: maxPoints - index
          }))
        };

        data.currentElection.votes.push(vote);
        saveData();
        return interaction.reply({ 
          content: `✅ Vote recorded!\nYour ranking:\n${
            vote.points.map((p, i) => `${i+1}. ${p.points} pts: <@${p.candidate}>`).join('\n')
          }`, 
          ephemeral: true 
        });

      case 'election':
        if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
          return interaction.reply({ content: 'Insufficient permissions!', ephemeral: true });
        }

        const subcommand = options.getSubcommand();
        switch(subcommand) {
          case 'start':
            if (data.currentElection?.isActive) {
              return interaction.reply('Election already in progress!');
            }
            data.currentElection = {
              candidates: [...data.registeredCandidates],
              votes: [],
              isActive: true
            };
            saveData();
            return interaction.reply(
              `🗳️ New election started with ${data.currentElection.candidates.length} candidates!\n` +
              `Candidates: ${data.currentElection.candidates.map(c => `<@${c}>`).join(' ')}\n\n` +
              `**How to vote:**\n` +
              `Use \`/vote\` and select candidates in order of preference\n` +
              `1st choice gets ${data.currentElection.candidates.length} points\n` +
              `2nd choice gets ${data.currentElection.candidates.length - 1} points\n` +
              `And so on...`
            );

          case 'end':
            if (!data.currentElection?.isActive) {
              return interaction.reply('No active election!');
            }
            data.currentElection.isActive = false;
            saveData();
            return interaction.reply('🏁 Election ended! Use `/election results` to see the outcome');

          case 'results':
            if (!data.currentElection || data.currentElection.isActive) {
              return interaction.reply('No results available!');
            }

            //Calculate results
            const scores = {};
            data.currentElection.candidates.forEach(c => scores[c] = 0);
            
            data.currentElection.votes.forEach(vote => {
              vote.points.forEach(p => {
                scores[p.candidate] += p.points;
              });
            });

            const results = Object.entries(scores)
              .sort((a, b) => b[1] - a[1])
              .map(([id, points], index) => `${index+1}. <@${id}>: ${points} points`);

            return interaction.reply(
              `🏆 **Election Results**\n` +
              `Total votes cast: ${data.currentElection.votes.length}\n` +
              `Number of candidates: ${data.currentElection.candidates.length}\n\n` +
              `${results.join('\n')}`
            );
        }
    }
  } catch (error) {
    console.error(error);
    interaction.reply({ content: '❌ An error occurred!', ephemeral: true });
  }
});

client.login(process.env.DISCORD_TOKEN);