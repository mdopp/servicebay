import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT_DIR = process.cwd();
const ENV_PATH = path.join(ROOT_DIR, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');

console.log('🔧 Running predev checks...');

// 1. Node version check
const nodeVersion = process.versions.node;
const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
if (majorVersion !== 20) {
  console.warn(`\x1b[33m⚠️  Warning: ServiceBay requires Node 20.x due to sqlite bindings (detected Node ${nodeVersion}).`);
  console.warn('   If you hit compilation or sqlite binding errors, please run "nvm use 20" or switch to Node 20.\x1b[0m');
} else {
  console.log(`✅ Node.js version is compatible (${nodeVersion})`);
}

// 2. Setup .env file with generated AUTH_SECRET if missing
try {
  let envContent = '';
  let envExists = fs.existsSync(ENV_PATH);

  if (envExists) {
    envContent = fs.readFileSync(ENV_PATH, 'utf8');
    console.log('✅ Found existing .env file');
  } else {
    console.log('📝 .env file not found. Copying template from .env.example...');
    if (fs.existsSync(ENV_EXAMPLE_PATH)) {
      envContent = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
    } else {
      envContent = '# ServiceBay Environment Variables\n';
    }
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    envExists = true;
  }

  // Check if AUTH_SECRET is set
  const authSecretMatch = envContent.match(/^AUTH_SECRET[ \t]*=[ \t]*([^\n\r]+)?/m);
  const secretExists = authSecretMatch && authSecretMatch[1] && authSecretMatch[1].trim().length > 0;

  if (!secretExists) {
    console.log('⚡ AUTH_SECRET is not configured. Automatically generating a secure secret...');
    const secureSecret = crypto.randomBytes(32).toString('hex');
    
    if (authSecretMatch) {
      // Replace existing empty or placeholder AUTH_SECRET
      envContent = envContent.replace(/^AUTH_SECRET[ \t]*=[ \t]*.*$/m, `AUTH_SECRET=${secureSecret}`);
    } else {
      // Append AUTH_SECRET
      envContent += `\n# Generated automatically by predev.mjs\nAUTH_SECRET=${secureSecret}\n`;
    }

    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    console.log('✅ Generated secure AUTH_SECRET and updated .env file');
  } else {
    console.log('✅ AUTH_SECRET is configured');
  }

} catch (error) {
  console.error('❌ Failed during predev environment setup:', error);
}

console.log('🚀 Predev checks complete!\n');
process.exit(0);
