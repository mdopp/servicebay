import { loadEnvConfig } from '@next/env';

const dev = process.env.NODE_ENV !== 'production';
loadEnvConfig(process.cwd(), dev, { info: (msg) => console.log(`[Env] ${msg}`), error: (err) => console.error(`[Env Error] ${err}`) });
