const fs = require('fs');
const path = require('path');
const https = require('https');

const FONTS = [
  {
    name: 'Bangers-Regular.ttf',
    urls: [
      'https://github.com/google/fonts/raw/main/ofl/bangers/Bangers-Regular.ttf',
      'https://github.com/google/fonts/raw/master/ofl/bangers/Bangers-Regular.ttf'
    ]
  },
  {
    name: 'LilitaOne-Regular.ttf',
    urls: [
      'https://github.com/google/fonts/raw/main/ofl/lilitaone/LilitaOne-Regular.ttf',
      'https://github.com/google/fonts/raw/master/ofl/lilitaone/LilitaOne-Regular.ttf'
    ]
  },
  {
    name: 'BebasNeue-Regular.ttf',
    urls: [
      'https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf',
      'https://github.com/google/fonts/raw/master/ofl/bebasneue/BebasNeue-Regular.ttf'
    ]
  },
  {
    name: 'Montserrat-Black.ttf',
    urls: [
      'https://unpkg.com/@fontsource/montserrat@4.5.15/files/montserrat-latin-900-normal.ttf',
      'https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Black.ttf'
    ]
  },
  {
    name: 'Oswald-Bold.ttf',
    urls: [
      'https://github.com/googlefonts/OswaldFont/raw/main/fonts/ttf/Oswald-Bold.ttf',
      'https://github.com/google/fonts/raw/main/ofl/oswald/static/Oswald-Bold.ttf'
    ]
  },
  {
    name: 'Anton-Regular.ttf',
    urls: [
      'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf',
      'https://github.com/google/fonts/raw/master/ofl/anton/Anton-Regular.ttf'
    ]
  },
  {
    name: 'FredokaOne-Regular.ttf',
    urls: [
      'https://github.com/pimoroni/fonts-python/raw/master/font-fredoka-one/font_fredoka_one/files/FredokaOne-Regular.ttf'
    ]
  }
];

const destDir = path.join(__dirname, '..', 'resources', 'fonts');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      // Follow redirects (handle 301, 302, 307, 308, etc.)
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        try {
          const resolvedUrl = new URL(response.headers.location, url).toString();
          download(resolvedUrl, dest).then(resolve).catch(reject);
        } catch (err) {
          reject(err);
        }
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Status Code: ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log(`Downloading fonts into: ${destDir}`);
  for (const font of FONTS) {
    const destPath = path.join(destDir, font.name);
    console.log(`Downloading ${font.name}...`);
    let success = false;
    for (const url of font.urls) {
      try {
        await download(url, destPath);
        console.log(`Successfully downloaded ${font.name} from ${url}`);
        success = true;
        break;
      } catch (err) {
        console.warn(`  Failed candidate URL: ${url} - Error: ${err.message}`);
      }
    }
    if (!success) {
      console.error(`Error: Failed to download ${font.name} from all candidate URLs.`);
    }
  }
  console.log('All downloads completed!');
}

main().catch(console.error);
