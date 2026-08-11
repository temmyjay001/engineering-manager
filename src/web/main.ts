import { startServer } from './server';

try {
  process.loadEnvFile('.env');
} catch {
  void 0;
}

startServer();
