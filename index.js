#!/usr/bin/env node

import { execSync } from 'child_process';

const COMPOSE_FILE = 'docker-compose.yml';

const args = process.argv.slice(2);

const command = args[0];
let peerCount = 1;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--peers' && args[i + 1]) {
    peerCount = Number(args[i + 1]);
  }
}

if (!Number.isInteger(peerCount) || peerCount < 1) {
  console.error('❌ --peers must be a positive integer');
  process.exit(1);
}

function run(cmd) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

switch (command) {
  case 'build':
    run(`docker compose -f ${COMPOSE_FILE} build`);
    break;

  case 'up':
    run(`docker compose -f ${COMPOSE_FILE} up -d --scale peer=${peerCount}`);
    break;

  case 'down':
    run(`docker compose -f ${COMPOSE_FILE} down`);
    break;

  case 'all':
    run(`docker compose -f ${COMPOSE_FILE} build`);
    run(`docker compose -f ${COMPOSE_FILE} up -d --scale peer=${peerCount}`);
    break;

  default:
    console.log(`
Usage:
  npm run docker -- build
  npm run docker -- up --peers 3
  npm run docker -- down
  npm run docker -- all --peers 3

Commands:
  build      Build Docker images
  up         Start containers
  down       Stop containers
  all        Generate + build + run
`);
    process.exit(1);
}
