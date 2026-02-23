/**
 * WordPress to Webflow CMS Sync Script
 * Zero external dependencies - uses only Node.js built-in modules
 * Targets the table immediately following the "WILKINSON TABLE" heading
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

// Parse the table immediately after the "WILKINSON TABLE" marker
function parseTable(html) {
  const teams = [];

  // Find the position of "WILKINSON TABLE" text, then grab the NEXT table after it
  const markerIndex = html.search(/WILKINSON TABLE/i);
  if (markerIndex === -1) {
    console.log('Could not find "WILKINSON TABLE" marker on page');
    return teams;
  }

  const htmlAfterMarker = html.slice(markerIndex);

  const tableMatch = htmlAfterMarker.match(/<table[^>]*>[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    console.log('No table found after WILKINSON TABLE marker');
    return teams;
  }

  const firstTable = tableMatch[0];
  console.log('   ✓ Found Wilkinson table (by marker)\n');

  // Find table rows within the target table
  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = firstTable.match(rowRegex) || [];

  for (const row of rows) {
    // Skip header rows
    if (row.includes('<th')) continue;

    // Extract all cell contents
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let match;

    while ((match = cellRegex.exec(row)) !== null) {
      // Clean up the cell content - remove HTML tags and trim
      let content = match[1]
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .trim();
      cells.push(content);
    }

    // We need at least 10 cells for a valid team row
    if (cells.length >= 10) {
      const position = parseInt(cells[0]);
      if (!isNaN(position) && position > 0 && position <= 20) {
        teams.push({
          name: cells[1],
          position: position,
          played:       parseInt(cells[2]) || 0,
          wins:         parseInt(cells[3]) || 0,
          otWins:       parseInt(cells[4]) || 0,
          otLosses:     parseInt(cells[5]) || 0,
          losses:       parseInt(cells[6]) || 0,
          goalsFor:     parseInt(cells[7]) || 0,
          goalsAgainst: parseInt(cells[8]) || 0,
          points:       parseInt(cells[9]) || 0
        });
      }
    }
  }

  return teams;
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

    // Map our internal names to Webflow slugs
    const lowerName = displayName.toLowerCase().replace(/\s+/g, '');

    if (lowerName === 'position') fieldMap.position = slug;
    if (lowerName === 'played')   fieldMap.played = slug;
    if (lowerName === 'wins')     fieldMap.wins = slug;
    if (lowerName === 'otwins')   fieldMap.otWins = slug;
    if (lowerName === 'otlosses') fieldMap.otLosses = slug;
    if (lowerName === 'losses')   fieldMap.losses = slug;
    if (lowerName === 'goalsfor') fieldMap.goalsFor = slug;
    if (lowerName === 'goalsagainst') fieldMap.goalsAgainst = slug;
    if (lowerName === 'points')   fieldMap.points = slug;
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

  // Map our data to the actual Webflow field slugs
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

  // Map our data to the actual Webflow field slugs
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
  console.log('📌 Only syncing the FIRST table (Wilkinson table)\n');

  // Validate config
  if (!CONFIG.webflowApiToken || !CONFIG.webflowCollectionId) {
    console.error('❌ Missing required environment variables!');
    console.error('   Make sure WEBFLOW_API_TOKEN and WEBFLOW_COLLECTION_ID are set.');
    process.exit(1);
  }

  try {
    // Step 1: Get collection schema to find field slugs
    console.log('🔧 Fetching collection schema...');
    const schema = await getCollectionSchema();
    const fieldMap = buildFieldMap(schema);

    // Step 2: Fetch WordPress page
    console.log('📥 Fetching WordPress page...');
    const html = await fetchHTML(CONFIG.wordpressUrl);
    console.log(`   ✓ Fetched ${html.length} characters\n`);

    // Step 3: Parse the table after the WILKINSON TABLE marker
    console.log('🔍 Parsing Wilkinson table data...');
    const teams = parseTable(html);
    console.log(`   ✓ Found ${teams.length} teams in Wilkinson table\n`);

    if (teams.length === 0) {
      console.error('❌ No teams found in the table!');
      process.exit(1);
    }

    // Log found teams
    console.log('📋 Teams found:');
    teams.forEach(t => console.log(`   ${t.position}. ${t.name} - ${t.points} pts`));
    console.log('');

    // Step 4: Get existing Webflow items
    console.log('📊 Fetching existing Webflow items...');
    const existingItems = await getExistingItems();
    console.log(`   ✓ Found ${existingItems.length} existing items\n`);

    // Create a map of existing items by name
    const existingMap = new Map();
    existingItems.forEach(item => {
      if (item.fieldData && item.fieldData.name) {
        existingMap.set(item.fieldData.name, item.id);
      }
    });

    // Step 5: Sync each team
    console.log('🔄 Syncing teams to Webflow...');
    let created = 0;
    let updated = 0;

    for (const team of teams) {
      const existingId = existingMap.get(team.name);

      if (existingId) {
        // Update existing
        const result = await updateItem(existingId, team, fieldMap);
        if (result.status >= 200 && result.status < 300) {
          console.log(`   ✓ Updated: ${team.name}`);
          updated++;
        } else {
          console.log(`   ⚠ Failed to update ${team.name}: ${JSON.stringify(result.data)}`);
        }
      } else {
        // Create new
        const result = await createItem(team, fieldMap);
        if (result.status >= 200 && result.status < 300) {
          console.log(`   ✓ Created: ${team.name}`);
          created++;
        } else {
          console.log(`   ⚠ Failed to create ${team.name}: ${JSON.stringify(result.data)}`);
        }
      }

      // Small delay to avoid rate limiting
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
