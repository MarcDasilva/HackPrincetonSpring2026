/**
 * Minecraft Bot Controller
 * 
 * This connects to a Minecraft server and can be controlled via the agent system
 */

import mineflayer from 'mineflayer';

class MinecraftBot {
  constructor() {
    this.bot = null;
    this.isConnected = false;
  }

  /**
   * Connect to a Minecraft server
   */
  async connect(options = {}) {
    const config = {
      host: options.host || 'localhost',
      port: options.port || 25565,
      username: options.username || 'SpectrumBot',
      version: options.version || '1.20.1', // Adjust based on your server
      // For offline mode servers:
      auth: options.auth || 'offline',
    };

    console.log(`🎮 Connecting to Minecraft server at ${config.host}:${config.port}...`);

    this.bot = mineflayer.createBot(config);

    return new Promise((resolve, reject) => {
      // When successfully spawned in the world
      this.bot.once('spawn', () => {
        this.isConnected = true;
        console.log(`✅ Connected to Minecraft as ${this.bot.username}`);
        console.log(`📍 Position: ${this.bot.entity.position}`);
        resolve(this.bot);
      });

      // Handle errors
      this.bot.once('error', (err) => {
        console.error('❌ Minecraft connection error:', err.message);
        reject(err);
      });

      // Handle kicks
      this.bot.once('kicked', (reason) => {
        console.log(`❌ Kicked from server: ${reason}`);
        this.isConnected = false;
      });

      // Handle disconnect
      this.bot.once('end', () => {
        console.log('🔌 Disconnected from Minecraft server');
        this.isConnected = false;
      });
    });
  }

  /**
   * Execute a chat command
   */
  chat(message) {
    if (!this.isConnected) {
      throw new Error('Not connected to Minecraft server');
    }
    this.bot.chat(message);
    return `Sent to Minecraft: ${message}`;
  }

  /**
   * Mine a specific block type
   */
  async mine(blockName, count = 1) {
    if (!this.isConnected) {
      throw new Error('Not connected to Minecraft server');
    }

    console.log(`⛏️ Mining ${count} ${blockName}...`);
    
    // Find the nearest block of that type
    const mcData = require('minecraft-data')(this.bot.version);
    const blockType = mcData.blocksByName[blockName];
    
    if (!blockType) {
      return `❌ Unknown block type: ${blockName}`;
    }

    const block = this.bot.findBlock({
      matching: blockType.id,
      maxDistance: 64,
    });

    if (!block) {
      return `❌ No ${blockName} found nearby`;
    }

    try {
      await this.bot.dig(block);
      return `✅ Mined ${blockName}`;
    } catch (err) {
      return `❌ Failed to mine: ${err.message}`;
    }
  }

  /**
   * Move to specific coordinates
   */
  async moveTo(x, y, z) {
    if (!this.isConnected) {
      throw new Error('Not connected to Minecraft server');
    }

    console.log(`🚶 Moving to ${x}, ${y}, ${z}...`);
    
    const pathfinder = require('mineflayer-pathfinder');
    const { goals } = pathfinder;
    
    this.bot.loadPlugin(pathfinder.pathfinder);
    
    const goal = new goals.GoalBlock(x, y, z);
    
    try {
      await this.bot.pathfinder.goto(goal);
      return `✅ Arrived at ${x}, ${y}, ${z}`;
    } catch (err) {
      return `❌ Failed to reach destination: ${err.message}`;
    }
  }

  /**
   * Get bot's current status
   */
  getStatus() {
    if (!this.isConnected) {
      return {
        connected: false,
        message: 'Not connected to Minecraft'
      };
    }

    const pos = this.bot.entity.position;
    const health = this.bot.health;
    const food = this.bot.food;

    return {
      connected: true,
      position: `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`,
      health: health,
      food: food,
      time: this.bot.time.timeOfDay,
      weather: this.bot.isRaining ? 'Raining' : 'Clear',
    };
  }

  /**
   * Build a simple structure
   */
  async build(structureType) {
    if (!this.isConnected) {
      throw new Error('Not connected to Minecraft server');
    }

    console.log(`🔨 Building ${structureType}...`);
    
    // Placeholder for building logic
    // You'll need to implement actual building based on structure type
    return `🔨 Starting to build ${structureType}...`;
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    if (this.bot) {
      this.bot.quit();
      this.isConnected = false;
      console.log('👋 Disconnected from Minecraft');
    }
  }
}

export default MinecraftBot;
