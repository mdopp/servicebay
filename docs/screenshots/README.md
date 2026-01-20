# ServiceBay Screenshots Guide

This directory contains screenshots for the main README.md. Follow these instructions to capture and update them.

## Required Screenshots

### 1. Dashboard (`dashboard.png`)
**URL**: `http://localhost:3000/`
**What to capture**: Main dashboard showing:
- At least 3-4 services (nginx-web, servicebay, etc.)
- Status indicators (green dots for running services)
- Port numbers visible
- Quick action buttons
- Left sidebar with navigation

**Recommended size**: 1920x1080, cropped to browser window

---

### 2. Network Map (`network-map.png`)
**URL**: `http://localhost:3000/`  
**Plugin**: Click "Network" in the sidebar
**What to capture**: Graph visualization showing:
- Internet gateway node
- Services interconnected with lines
- Color-coded nodes (green for healthy)
- Zoom controls in bottom right
- Legend showing node types

**Recommended size**: 1920x1080, cropped to browser window

---

### 3. Services Plugin (`services-plugin.png`)
**URL**: `http://localhost:3000/`  
**Plugin**: Click "Services" in the sidebar
**What to capture**: Services list showing:
- Multiple services with their cards
- Status badges (Active, Inactive)
- Port mappings
- Action buttons (Edit, Logs, Restart, etc.)
- Service type indicators (Managed/Unmanaged)

**Recommended size**: 1920x1080, cropped to browser window

---

### 4. Monitoring Dashboard (`monitoring.png`)
**URL**: `http://localhost:3000/`  
**Plugin**: Click "Monitoring" in the sidebar
**What to capture**: Health checks panel showing:
- Health check configuration cards
- Status indicators (checkmarks, X marks)
- Uptime percentages
- Response times
- History graphs if available

**Recommended size**: 1920x1080, cropped to browser window

---

### 5. Settings Panel (`settings.png`)
**URL**: `http://localhost:3000/`  
**Plugin**: Click "Settings" in the sidebar
**What to capture**: Settings page showing:
- Node management section with SSH nodes listed
- Connection status indicators
- Template variables section
- System backups section
- Any active configuration panels

**Recommended size**: 1920x1080, cropped to browser window

---

## How to Capture Screenshots

### Method 1: Browser DevTools (Recommended)
1. Open ServiceBay in Chrome/Edge: `http://localhost:3000`
2. Press `F12` to open DevTools
3. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
4. Type "Capture screenshot" and select "Capture screenshot"
5. Save to this directory with the appropriate filename

### Method 2: Using ImageMagick (Linux)
```bash
# Make sure ServiceBay is running
npm run dev

# Open browser to localhost:3000, navigate to desired view
# Then capture with:
import dashboard.png

# Click on the window to capture it
```

### Method 3: Using Firefox Developer Tools
1. Open ServiceBay in Firefox: `http://localhost:3000`
2. Press `Shift+F2` to open Developer Toolbar
3. Type: `screenshot --fullpage dashboard.png`
4. Repeat for each view

### Method 4: Using Playwright (Automated)
Create a script `capture-screenshots.js`:

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Dashboard
  await page.goto('http://localhost:3000/');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/dashboard.png' });

  // Network Map
  await page.click('text=Network');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/network-map.png' });

  // Services
  await page.click('text=Services');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/services-plugin.png' });

  // Monitoring
  await page.click('text=Monitoring');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/monitoring.png' });

  // Settings
  await page.click('text=Settings');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'docs/screenshots/settings.png' });

  await browser.close();
})();
```

Run with: `node capture-screenshots.js`

---

## Image Optimization

After capturing, optimize images:

```bash
# Install optipng and jpegoptim
sudo apt install optipng jpegoptim  # Debian/Ubuntu
sudo dnf install optipng jpegoptim  # Fedora

# Optimize PNGs
optipng -o7 *.png

# Or convert to WebP for better compression
for file in *.png; do
  cwebp -q 85 "$file" -o "${file%.png}.webp"
done
```

---

## Placeholder Images (Temporary)

If screenshots aren't available yet, use this SVG placeholder:

```html
<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="#1a1a1a"/>
  <text x="50%" y="50%" font-size="48" fill="#ffffff" 
        text-anchor="middle" dominant-baseline="middle">
    ServiceBay Dashboard Screenshot
  </text>
</svg>
```

---

## Tips for Great Screenshots

1. **Clean data**: Use realistic but clean service names (avoid test1, test2, etc.)
2. **Show functionality**: Capture with some services running, some stopped
3. **Consistent theme**: Use the same color theme across all screenshots
4. **No sensitive info**: Avoid showing real IPs, passwords, or personal data
5. **Focus on UI**: Crop to show the application, not desktop background
6. **Good lighting**: If using dark theme, ensure text is readable
7. **Resolution**: Minimum 1920x1080 for desktop views

---

## Current Status

- [ ] dashboard.png
- [ ] network-map.png
- [ ] services-plugin.png
- [ ] monitoring.png
- [ ] settings.png

Once all screenshots are captured, update this checklist and commit them to git.
