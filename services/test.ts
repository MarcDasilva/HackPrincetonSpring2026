// test.ts
import { WorldStateService } from './WorldStateService.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const world = new WorldStateService();

  // Try creating an object
  const obj = await world.createObject(
    'Test Chest',
    'chest',
    { x: 10, y: 64, z: 5 },
    { items: ['pickaxe', 'wood'] },
    'agent-1'
  );
  console.log('Created:', obj);

  // Try reading it back
  const fetched = await world.getObjectsByType('chest');
  console.log('All chests:', fetched);
}

main().catch(console.error);