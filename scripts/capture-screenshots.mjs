#!/usr/bin/env node
/**
 * Automated Screenshot Capture for ServiceBay
 * 
 * Prerequisites:
 *   npm install -D playwright
 *   npx playwright install chromium
 * 
 * Usage:
 *   1. Start dev server: npm run dev
 *   2. Run this script: node scripts/capture-screenshots.js
 */

import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCREENSHOTS_DIR = join(__dirname, '..', 'docs', 'screenshots');
const BASE_URL = 'http://localhost:3000';

async function captureScreenshots() {
  console.log('🚀 Starting ServiceBay screenshot capture...\n');

  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  
  const page = await context.newPage();

  try {
    // 1. Dashboard
    console.log('📸 Capturing dashboard...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000); // Let animations settle
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, 'dashboard.png'),
      fullPage: false 
    });
    console.log('✅ Dashboard captured\n');

    // 2. Network Map
    console.log('📸 Capturing network map...');
    const networkButton = page.locator('text=Network').first();
    if (await networkButton.isVisible()) {
      await networkButton.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ 
        path: join(SCREENSHOTS_DIR, 'network-map.png'),
        fullPage: false 
      });
      console.log('✅ Network map captured\n');
    } else {
      console.log('⚠️  Network button not found, skipping\n');
    }

    // 3. Services Plugin
    console.log('📸 Capturing services plugin...');
    const servicesButton = page.locator('text=Services').first();
    if (await servicesButton.isVisible()) {
      await servicesButton.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ 
        path: join(SCREENSHOTS_DIR, 'services-plugin.png'),
        fullPage: false 
      });
      console.log('✅ Services plugin captured\n');
    } else {
      console.log('⚠️  Services button not found, skipping\n');
    }

    // 4. Monitoring
    console.log('📸 Capturing monitoring dashboard...');
    const monitoringButton = page.locator('text=Monitoring').first();
    if (await monitoringButton.isVisible()) {
      await monitoringButton.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ 
        path: join(SCREENSHOTS_DIR, 'monitoring.png'),
        fullPage: false 
      });
      console.log('✅ Monitoring dashboard captured\n');
    } else {
      console.log('⚠️  Monitoring button not found, skipping\n');
    }

    // 5. Settings
    console.log('📸 Capturing settings panel...');
    const settingsButton = page.locator('text=Settings').first();
    if (await settingsButton.isVisible()) {
      await settingsButton.click();
      await page.waitForTimeout(2000);
      await page.screenshot({ 
        path: join(SCREENSHOTS_DIR, 'settings.png'),
        fullPage: false 
      });
      console.log('✅ Settings panel captured\n');
    } else {
      console.log('⚠️  Settings button not found, skipping\n');
    }

    console.log('🎉 All screenshots captured successfully!');
    console.log(`📁 Location: ${SCREENSHOTS_DIR}`);

  } catch (err) {
    console.error('❌ Error capturing screenshots:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// Check if dev server is running
async function checkServer() {
  try {
    const response = await fetch(BASE_URL);
    if (!response.ok) {
      throw new Error('Server not responding correctly');
    }
    return true;
  } catch (error) {
    console.error('❌ ServiceBay dev server not running!');
    console.error('   Start it with: npm run dev');
    console.error('   Then run this script again.\n');
    process.exit(1);
  }
}

// Main execution
(async () => {
  await checkServer();
  await captureScreenshots();
})();
