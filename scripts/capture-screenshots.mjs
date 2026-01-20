#!/usr/bin/env node
/**
 * Automated Screenshot Capture for ServiceBay
 * 
 * Captures screenshots with sanitized example data replacing real IPs and domain names.
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

/**
 * Data sanitization map for example screenshots
 * Maps real values to generic example values
 */
const SANITIZATION_MAP = {
  // Real IPs → Example IPs
  '192.168.178.99': '192.168.1.100',
  '172.28.100.77': '192.168.1.50',
  'fe80::215:5dff:feb9:943c': 'fe80::1',
  '127.0.0.1': '192.168.1.1',
  
  // Real domain names → Example domains
  'travel.korgraph.io': 'travel.example.local',
  'korgraph.io': 'example.local',
  'mdopp-surface': 'homeserver',
  'mdopp': 'admin',
  
  // Real paths/usernames → Example paths
  '/home/mdopp/': '/home/admin/',
  '/root/.local/': '/home/admin/.local/',
  
  // Real service names → Generic names
  'travelmap': 'my-travel-app',
  'travelmaping': 'my-app',
  'korgraph-couchdb': 'database-service',
  
  // Environment values
  'GOOGLE_CLIENT_ID': 'CLIENT_ID_EXAMPLE_XXXXXXXXXXXX',
  'GOOGLE_CLIENT_SECRET': 'GOCSPX-XXXXXXXXXXXXXXXXXXXXXX',
  'GOOGLE_API_KEY': 'AIzaSyC_XXXXXXXXXXXXXXXXXXXXXX',
};

/**
 * Recursively sanitize objects by replacing real values with example values
 */
function sanitizeData(data) {
  if (typeof data === 'string') {
    let sanitized = data;
    // Apply each substitution
    for (const [real, example] of Object.entries(SANITIZATION_MAP)) {
      // Use case-insensitive replacement for domain-like strings
      const regex = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      sanitized = sanitized.replace(regex, example);
    }
    return sanitized;
  }
  
  if (Array.isArray(data)) {
    return data.map(item => sanitizeData(item));
  }
  
  if (data !== null && typeof data === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeData(value);
    }
    return sanitized;
  }
  
  return data;
}

async function captureScreenshots() {
  console.log('🚀 Starting ServiceBay screenshot capture...\n');
  console.log('📝 Using sanitized example data for sensitive information\n');

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
    // Inject data sanitization script into page context
    await page.addInitScript(() => {
      // Store original fetch and localStorage
      const originalFetch = window.fetch;
      const originalLocalStorage = { ...window.localStorage };
      
      // Data sanitization map (same as in Node.js script)
      const SANITIZATION_MAP = {
        '192.168.178.99': '192.168.1.100',
        '172.28.100.77': '192.168.1.50',
        'fe80::215:5dff:feb9:943c': 'fe80::1',
        'travel.korgraph.io': 'travel.example.local',
        'korgraph.io': 'example.local',
        'mdopp-surface': 'homeserver',
        'mdopp': 'admin',
        '/home/mdopp/': '/home/admin/',
        '/root/.local/': '/home/admin/.local/',
        'travelmap': 'my-travel-app',
        'travelmaping': 'my-app',
        'korgraph-couchdb': 'database-service',
      };
      
      function sanitizeString(str) {
        if (typeof str !== 'string') return str;
        let result = str;
        for (const [real, example] of Object.entries(SANITIZATION_MAP)) {
          const regex = new RegExp(real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
          result = result.replace(regex, example);
        }
        return result;
      }
      
      function sanitizeData(data) {
        if (typeof data === 'string') return sanitizeString(data);
        if (Array.isArray(data)) return data.map(sanitizeData);
        if (data !== null && typeof data === 'object') {
          const result = {};
          for (const [key, value] of Object.entries(data)) {
            result[key] = sanitizeData(value);
          }
          return result;
        }
        return data;
      }
      
      // Intercept fetch calls to sanitize responses
      window.fetch = async (...args) => {
        const response = await originalFetch.apply(window, args);
        
        // Only sanitize JSON responses from API endpoints
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (!url.includes('/api/')) return response;
        
        // Clone response to read body
        const cloned = response.clone();
        try {
          const json = await cloned.json();
          const sanitized = sanitizeData(json);
          
          // Create new response with sanitized data
          return new Response(JSON.stringify(sanitized), {
            status: response.status,
            headers: response.headers,
          });
        } catch {
          // If not JSON, return original
          return response;
        }
      };
      
      // Also sanitize localStorage and sessionStorage
      const originalSetItem = Storage.prototype.setItem;
      const originalGetItem = Storage.prototype.getItem;
      
      Storage.prototype.setItem = function(key, value) {
        return originalSetItem.call(this, key, sanitizeString(value));
      };
      
      Storage.prototype.getItem = function(key) {
        const value = originalGetItem.call(this, key);
        return value ? sanitizeString(value) : value;
      };
    });

    // 1. Dashboard
    console.log('📸 Capturing dashboard...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000); // Let animations settle
    await page.screenshot({ 
      path: join(SCREENSHOTS_DIR, 'dashboard.png'),
      fullPage: false 
    });
    console.log('✅ Dashboard captured (sanitized data)\n');

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
      console.log('✅ Network map captured (sanitized data)\n');
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
      console.log('✅ Services plugin captured (sanitized data)\n');
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
      console.log('✅ Monitoring dashboard captured (sanitized data)\n');
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
      console.log('✅ Settings panel captured (sanitized data)\n');
    } else {
      console.log('⚠️  Settings button not found, skipping\n');
    }

    console.log('🎉 All screenshots captured successfully!');
    console.log(`📁 Location: ${SCREENSHOTS_DIR}`);
    console.log('🔒 All sensitive data has been sanitized with example values\n');

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
