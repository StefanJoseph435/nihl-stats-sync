/**
 * WordPress to Webflow CMS Sync Script
 * Zero external dependencies - uses only Node.js built-in modules
 * Automatically identifies the correct standings table by matching:
 *   1. Team names against Webflow CMS
 *   2. Column structure (numeric stats, not fixture scores)
 */

const https = require('https');

// Configuration from environment variables
const CONFIG = {
  wordpressUrl: 'https://nihlstats.wordpress.com/2025/07/22/south-2-wilkinson-tables-5/',
  webflowApiToken: process.env.WEBFLOW_API_TOKEN,
  webflowCollectionId: process.env.WEBFLOW_COLLECTION_ID,
  webflowSiteId: process.env.WEBFLOW_SITE_ID
};

// Simple HTTPS request function
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// Fetch HTML from WordPress
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Clean HTML content from a cell
function cleanCell(content) {
  return content
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

// Check whether a cell value looks like a standings stat (plain number)
// rather than a fixture result ("3-1", "TBC", "x", date like "14/2" etc.)
function isStatCell(value) {
  return /^\d+$/.test(value);
}

// Parse a single table into team rows, returning null if structure looks wrong
function parseTeamsFromTable(tableHtml) {
  const teams = [];
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const rows = tableHtml.match(rowRegex) || [];

  for (const row of rows) {
    if (row.includes('<th')) continue;

    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let match;

    while ((match = cellRegex.exec(row)) !== null) {
      cells.push(cleanCell(match[1]));
    }

    if (cells.length === 0) continue;

    // Find position number dynamically (scan first 3 cells)
    let positionIndex = -1;
    for (let i = 0; i < Math.min(cells.length, 3); i++) {
      const val = parseInt(cells[i]);
      if (!isNaN(val) && val > 0 && val <= 20) {
        positionIndex = i;
        break;
      }
    }

    if (positionIndex === -1) continue;

    const nameIndex = positionIndex + 1;
    const dataStart = positionIndex + 2;

    // Need at least 8 stat columns after the name
    if (cells.length < dataStart + 8) continue;
    if (!cells[nameIndex]) continue;

    // Check that the stat columns all look like plain numbers
    // If any look like "3-1", "TBC", "x", "14/2" etc. this is a fixture grid - skip it
    const statCells = cells.slice(dataStart, dataStart + 8);
    const allStats = statCells.every(c => isStatCell(c));
    if (!allStats) continue;

    teams.push({
      name:         cells[nameIndex],
      position:     parseInt(cells[positionIndex]),
      played:       parseInt(cells[dataStart])     || 0,
      wins:         parseInt(cells[dataStart + 1]) || 0,
      otWins:       parseInt(cells[dataStart + 2]) || 0,
      otLosses:     parseInt(cells[dataStart + 3]) || 0,
      losses:       parseInt(cells[dataStart + 4]) || 0,
      goalsFor:     parseInt(cells[dataStart + 5]) || 0,
      goalsAgainst: parseInt(cells[dataStart + 6]) || 0,
      points:       parseInt(cells[dataStart + 7]) || 0
    });
  }

  return teams;
}

// Extract all tables from the page HTML
function extractAllTables(html) {
  const tables = [];
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let match;
  while ((match = tableRegex.exec(html)) !== null) {
    tables.push(match[0]);
  }
  return tables;
}

// Find the table that best matches Webflow team names AND has the right data structure
function findBestMatchingTable(tables, webflowTeamNames) {
  const knownNames = new Set(webflowTeamNames.map(n => n.toLowerCase().trim()));
  let bestTeams = null;
  let bestScore = 0;
  let bestIndex = -1;

  tables.forEach((tableHtml, index) => {
    const teams = parseTeamsFromTable(tableHtml);

    if (teams.length === 0) {
      console.log(`   Table ${index + 1}: skipped (no valid standings rows)`);
      return;
    }

    const matches = teams.filter(t => knownNames.has(t.name.toLowerCase().trim())).length;
    console.log(`   Table ${index + 1}: ${teams.length} standings rows, ${matches}/${knownNames.size} team names matched`);

    if (matches > bestScore) {
      bestScore = matches;
      bestTeams = teams;
      bestIndex = index + 1;
    }
  });

  return { teams: bestTeams, score: bestScore, tableNumber: bestIndex };
}

// Get collection schema to find correct field slugs
async function getCollectionSchema() {
  const options = {
    hostname: 'api.webflow.com',
    path: `/v2/collections/${CONFIG.webflowCollectionId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${CONFIG.webflowApiToken}`,
      'accept': 'application/json'
    }
  };

  const response = await httpsRequest(options);
  return response.data;
}

// Get existing items from Webflow
async function getExistingItems() {
  const options = {
    hostname: 'api.webflow.com',
    path: `/v2/collections/${CONFIG.webflowCollectionId}/items`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${CONFIG.webflowApiToken}`,
      'accept': 'application/json'
    }
  };

  const response = await httpsRequest(options);
  return response.data.items || [];
}

// Build field mapping from collection schema
function buildFieldMap(schema) {
  const fieldMap = {};
  const fields = schema.fields || [];

  console.log('📋 Available fields in collection:');

  for (const field of fields) {
    const slug = field.slug;
    const displayName = field.displayName || field.name || slug;
    console.log(`   - ${displayName} → slug: "${slug}"`);

    const lowerName = displayName.toLowerCase().replace(/\s+/g, '');

    if (lowerName === 'position')     fieldMap.position     = slug;
    if (lowerName === 'played')       fieldMap.played       = slug;
    if (lowerName === 'wins')         fieldMap.wins         = slug;
    if (lowerName === 'otwins')       fieldMap.otWins       = slug;
    if (lowerName === 'otlosses')     fieldMap.otLosses     = slug;
    if (lowerName === 'losses')       fieldMap.losses       = slug;
    if (lowerName === 'goalsfor')     fieldMap.goalsFor     = slug;
    if (lowerName === 'goalsagainst') fieldMap.goalsAgainst = slug;
    if (lowerName === 'points')       fieldMap.points       = slug;
  }

  console.log('\n📌 Field mapping:');
  console.log(JSON.stringify(fieldMap, null, 2));
  console.log('');

  return fieldMap;
}

// Create a new item in Webflow
async function createItem(team, fieldMap) {
  const options = {
    hostname: 'api.webflow.com',
    path: `/v2/collections/${CONFIG.webflowCollectionId}/items`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.webflowApiToken}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    }
  };

  const fieldData = {
    name: team.name,
    slug: team.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
  };

  if (fieldMap.position)     fieldData[fieldMap.position]     = team.position;
  if (fieldMap.played)       fieldData[fieldMap.played]       = team.played;
  if (fieldMap.wins)         fieldData[fieldMap.wins]         = team.wins;
  if (fieldMap.otWins)       fieldData[fieldMap.otWins]       = team.otWins;
  if (fieldMap.otLosses)     fieldData[fieldMap.otLosses]     = team.otLosses;
  if (fieldMap.losses)       fieldData[fieldMap.losses]       = team.losses;
  if (fieldMap.goalsFor)     fieldData[fieldMap.goalsFor]     = team.goalsFor;
  if (fieldMap.goalsAgainst) fieldData[fieldMap.goalsAgainst] = team.goalsAgainst;
  if (fieldMap.points)       fieldData[fieldMap.points]       = team.points;

  const body = JSON.stringify({ fieldData });
  return httpsRequest(options, body);
}

// Update an existing item in Webflow
async function updateItem(itemId, team, fieldMap) {
  const options = {
    hostname: 'api.webflow.com',
    path: `/v2/collections/${CONFIG.webflowCollectionId}/items/${itemId}`,
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${CONFIG.webflowApiToken}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    }
  };

  const fieldData = {};

  if (fieldMap.position)     fieldData[fieldMap.position]     = team.position;
  if (fieldMap.played)       fieldData[fieldMap.played]       = team.played;
  if (fieldMap.wins)         fieldData[fieldMap.wins]         = team.wins;
  if (fieldMap.otWins)       fieldData[fieldMap.otWins]       = team.otWins;
  if (fieldMap.otLosses)     fieldData[fieldMap.otLosses]     = team.otLosses;
  if (fieldMap.losses)       fieldData[fieldMap.losses]       = team.losses;
  if (fieldMap.goalsFor)     fieldData[fieldMap.goalsFor]     = team.goalsFor;
  if (fieldMap.goalsAgainst) fieldData[fieldMap.goalsAgainst] = team.goalsAgainst;
  if (fieldMap.points)       fieldData[fieldMap.points]       = team.points;

  const body = JSON.stringify({ fieldData });
  return httpsRequest(options, body);
}

// Publish all items
async function publishItems() {
  const items = await getExistingItems();
  const itemIds = items.map(item => item.id);

  if (itemIds.length === 0) {
    console.log('No items to publish');
    return;
  }

  const options = {
    hostname: 'api.webflow.com',
    path: `/v2/collections/${CONFIG.webflowCollectionId}/items/publish`,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.webflowApiToken}`,
      'Content-Type': 'application/json',
      'accept': 'application/json'
    }
  };

  const body = JSON.stringify({ itemIds });
  return httpsRequest(options, body);
}

// Main sync function
async function sync() {
  console.log('🚀 Starting WordPress to Webflow sync...\n');

  if (!CONFIG.webflowApiToken || !CONFIG.webflowCollectionId) {
    console.error('❌ Missing required environment variables!');
    console.error('   Make sure WEBFLOW_API_TOKEN and WEBFLOW_COLLECTION_ID are set.');
    process.exit(1);
  }

  try {
    // Step 1: Get collection schema
    console.log('🔧 Fetching collection schema...');
    const schema = await getCollectionSchema();
    const fieldMap = buildFieldMap(schema);

    // Step 2: Get existing Webflow items (to use team names for matching)
    console.log('📊 Fetching existing Webflow items...');
    const existingItems = await getExistingItems();
    console.log(`   ✓ Found ${existingItems.length} existing items\n`);

    const webflowTeamNames = existingItems
      .map(item => item.fieldData && item.fieldData.name)
      .filter(Boolean);

    if (webflowTeamNames.length === 0) {
      console.error('❌ No team names found in Webflow collection — cannot match tables!');
      process.exit(1);
    }

    console.log(`   ✓ Webflow teams to match against: ${webflowTeamNames.join(', ')}\n`);

    // Step 3: Fetch WordPress page
    console.log('📥 Fetching WordPress page...');
    const html = await fetchHTML(CONFIG.wordpressUrl);
    console.log(`   ✓ Fetched ${html.length} characters\n`);

    // Step 4: Extract all tables and find the best match
    console.log('🔍 Scanning all tables on page...');
    const tables = extractAllTables(html);
    console.log(`   ✓ Found ${tables.length} tables total\n`);

    const { teams, score, tableNumber } = findBestMatchingTable(tables, webflowTeamNames);

    console.log('');

    if (!teams || score === 0) {
      console.error('❌ Could not find a table matching the Webflow team names!');
      process.exit(1);
    }

    console.log(`✅ Best match: Table ${tableNumber} with ${score} team name matches\n`);
    console.log('📋 Teams found:');
    teams.forEach(t => console.log(`   ${t.position}. ${t.name} - ${t.points} pts`));
    console.log('');

    // Step 5: Build existing items map and sync
    const existingMap = new Map();
    existingItems.forEach(item => {
      if (item.fieldData && item.fieldData.name) {
        existingMap.set(item.fieldData.name, item.id);
      }
    });

    console.log('🔄 Syncing teams to Webflow...');
    let created = 0;
    let updated = 0;

    for (const team of teams) {
      const existingId = existingMap.get(team.name);

      if (existingId) {
        const result = await updateItem(existingId, team, fieldMap);
        if (result.status >= 200 && result.status < 300) {
          console.log(`   ✓ Updated: ${team.name}`);
          updated++;
        } else {
          console.log(`   ⚠ Failed to update ${team.name}: ${JSON.stringify(result.data)}`);
        }
      } else {
        const result = await createItem(team, fieldMap);
        if (result.status >= 200 && result.status < 300) {
          console.log(`   ✓ Created: ${team.name}`);
          created++;
        } else {
          console.log(`   ⚠ Failed to create ${team.name}: ${JSON.stringify(result.data)}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`\n📈 Summary: ${created} created, ${updated} updated\n`);

    // Step 6: Publish changes
    console.log('📤 Publishing changes...');
    const publishResult = await publishItems();
    if (publishResult && publishResult.status >= 200 && publishResult.status < 300) {
      console.log('   ✓ Changes published!\n');
    } else {
      console.log('   ⚠ Publish response:', JSON.stringify(publishResult?.data || 'No response'));
    }

    console.log('✅ Sync complete!');

  } catch (error) {
    console.error('❌ Error during sync:', error.message);
    process.exit(1);
  }
}

// Run the sync
sync();
