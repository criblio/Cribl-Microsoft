# Quick Reference: PowerBI Connection Method

## ❌ DO NOT USE: Get Data > Web

The **Get Data > Web** connector cannot handle OAuth2 Client Credentials authentication because:
- It expects static URLs and headers
- Cannot exchange Client ID/Secret for bearer tokens
- Cannot refresh expired tokens automatically

## ✅ CORRECT METHOD: Get Data > Blank Query

### Step-by-Step Visual Guide

```
PowerBI Desktop
    │
    ├── Click "Get Data"
    │
    ├── Search for "Blank Query"  ← NOT "Web"!
    │
    ├── Click "Connect"
    │
    └── Power Query Editor Opens
            │
            ├── Right-click "Query1"
            │
            ├── Select "Advanced Editor"
            │
            ├── Paste the M Query code
            │
            ├── Update your credentials:
            │   - CriblInstance
            │   - ClientId  
            │   - ClientSecret
            │   - DatasetId
            │
            └── Click "Done"
```

## Why Blank Query?

**Blank Query allows you to write Power Query M code that:**
1. Exchanges Client ID/Secret for a bearer token
2. Uses the token to call Cribl Search API
3. Handles token refresh automatically
4. Processes the results into a table

## Sample Connection Code

```powerquery
let
    // Your credentials here
    CriblInstance = "your-instance.cribl.cloud",
    ClientId = "your-client-id",
    ClientSecret = "your-client-secret",
    
    // This happens automatically in the query:
    // 1. Get Bearer Token
    // 2. Create Search Job
    // 3. Get Results
    // 4. Convert to Table
    
    // ... (full code in QUICK_START.md)
in
    ResultsTable
```

## Common Mistake

❌ **Wrong**: Get Data > Web > Enter URL and Headers
- This won't work because you don't have a bearer token yet

✅ **Right**: Get Data > Blank Query > Paste M code
- The M code handles getting the token automatically

## Need Help?

See the full [QUICK_START.md](./QUICK_START.md) for complete instructions.