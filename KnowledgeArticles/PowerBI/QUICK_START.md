# PowerBI + Cribl Search API Quick Start Guide

This guide will help you connect PowerBI Desktop to the Cribl Search API to query data from Cribl Lake.

> **💡 Important**: This integration uses **Get Data > Blank Query**, NOT Get Data > Web. The Web connector cannot handle OAuth2 Client Credentials authentication required by Cribl.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Step 1: Obtain Cribl API Credentials](#step-1-obtain-cribl-api-credentials)
- [Step 2: Understanding Client Credentials Authentication](#step-2-understanding-client-credentials-authentication)
- [Step 3: Test Connection in PowerBI](#step-3-test-connection-in-powerbi)
- [Step 4: Create Custom Power Query](#step-4-create-custom-power-query)
- [Step 5: Transform and Load Data](#step-5-transform-and-load-data)
- [Troubleshooting](#troubleshooting)
- [Example Queries](#example-queries)

## Prerequisites

Before you begin, ensure you have:

- [ ] **PowerBI Desktop** installed (latest version recommended)
- [ ] **Cribl Cloud** instance with Search enabled
- [ ] **Cribl Lake** configured with datasets
- [ ] **API access** to your Cribl instance
- [ ] **Admin or appropriate permissions** in both Cribl and PowerBI
- [ ] **Understanding that you'll use Blank Query**, not the Web connector

### Required Information
Gather the following information:
- Cribl instance URL (e.g., `https://your-instance.cribl.cloud`)
- Client ID (from API Credentials)
- Client Secret (from API Credentials)
- Dataset ID(s) from Cribl Lake
- Time range for queries

## Step 1: Obtain Cribl API Credentials

1. Log into your Cribl instance
2. Navigate to **Cribl** → **Organization**  →  **API Credentials**
3. Click **Add Credential**
4. Configure the credential:
   - **Name**: `PowerBI-Integration`
   - **Org Permissions**: User
   - **Workspace Permissions**: Member
   - **Search Permissions**: User
5. Copy and securely store:
   - **Client ID**
   - **Client Secret**
   - **Audience** (typically your Cribl instance URL)

## Step 2: Understanding Client Credentials Authentication

### How It Works

With Client Credentials authentication:
1. PowerBI exchanges your Client ID and Secret for a Bearer Token
2. The Bearer Token is used for all API calls
3. Tokens expire (typically after 1 hour) and are automatically refreshed
4. All token management happens within the Power Query

### Key Points

- **No manual token management needed** - PowerBI handles everything
- **Credentials are stored securely** - Use PowerBI parameters for production
- **Automatic token refresh** - No need to worry about expiration
- **Test directly in PowerBI** - See Step 3 for connection testing

## Step 3: Test Connection in PowerBI

### Important: Use Blank Query, NOT Web Connector

⚠️ **Do NOT use Get Data > Web** - The Web connector cannot handle Client Credentials authentication.

✅ **Use Get Data > Blank Query** - This allows dynamic token exchange.

### Test Query for Connection Verification

1. Open **PowerBI Desktop**
2. Click **Get Data**
3. Search for **"Blank Query"** (NOT "Web"!)
4. Click **Connect**
5. In the Power Query Editor, right-click "Query1" and select **Advanced Editor**
6. Replace all content with this test query and update your credentials:

```powerquery
let
    // UPDATE THESE VALUES
    CriblInstance = "YOUR_INSTANCE.cribl.cloud",
    ClientId = "YOUR_CLIENT_ID",
    ClientSecret = "YOUR_CLIENT_SECRET",
    
    // Get Bearer Token
    TokenUrl = "https://" & CriblInstance & "/api/v1/auth/token",
    TokenBody = Json.FromValue([
        grant_type = "client_credentials",
        client_id = ClientId,
        client_secret = ClientSecret,
        audience = "https://" & CriblInstance
    ]),
    
    TokenResponse = Json.Document(
        Web.Contents(
            TokenUrl,
            [
                Headers = [#"Content-Type" = "application/json"],
                Content = Text.ToBinary(TokenBody)
            ]
        )
    ),
    
    BearerToken = TokenResponse[access_token],
    
    // Test API Connection
    TestUrl = "https://" & CriblInstance & "/api/v1/system/info",
    TestResponse = Json.Document(
        Web.Contents(
            TestUrl,
            [Headers = [#"Authorization" = "Bearer " & BearerToken]]
        )
    )
in
    TestResponse
```

7. Click **Done**
8. If prompted about privacy:
   - Select **Continue**
   - Set privacy level to **Organizational**
   - Click **Save**

### Interpreting Results

✅ **Success**: You'll see system information including Cribl version
❌ **Authentication Failed**: Check Client ID and Secret
❌ **Connection Error**: Verify instance URL is correct

### Setting up Data Source Settings

1. Go to **File** → **Options and settings** → **Data source settings**
2. Select your Cribl instance
3. Click **Edit Permissions**
4. Configure:
   - **Privacy Level**: Organizational
   - **Credentials**: Anonymous (authentication is handled in the query)

## Step 4: Create Custom Power Query

### Complete M Query for Cribl Search with Client Credentials

1. In PowerBI, click **Get Data**
2. Search for **"Blank Query"** (NOT "Web"!)
3. Click **Connect**
4. In the Power Query Editor, right-click "Query1" and select **Advanced Editor**
5. Replace all content with this code:

```powerquery
let
    // ===== CONFIGURATION =====
    // Update these values with your Cribl instance details
    CriblConfig = [
        Instance = "YOUR_INSTANCE.cribl.cloud",  // Without https://
        ClientId = "YOUR_CLIENT_ID",             // From Step 1
        ClientSecret = "YOUR_CLIENT_SECRET",     // From Step 1
        Dataset = "YOUR_DATASET",
        Query = "dataset=""YOUR_DATASET""",      // Cribl Search query
        Earliest = "-24h",                       // Time range start
        Latest = "now",                           // Time range end
        MaxResults = 10000,                       // Maximum results to return
        PollInterval = 2,                         // Seconds between status checks
        MaxWaitTime = 300                         // Maximum seconds to wait for results
    ],
    
    // ===== AUTHENTICATION =====
    
    // Get Bearer Token from Client Credentials
    GetBearerToken = () =>
        let
            TokenUrl = "https://" & CriblConfig[Instance] & "/api/v1/auth/token",
            TokenBody = Json.FromValue([
                grant_type = "client_credentials",
                client_id = CriblConfig[ClientId],
                client_secret = CriblConfig[ClientSecret],
                audience = "https://" & CriblConfig[Instance]
            ]),
            
            TokenResponse = Json.Document(
                Web.Contents(
                    TokenUrl,
                    [
                        Headers = [#"Content-Type" = "application/json"],
                        Content = Text.ToBinary(TokenBody)
                    ]
                )
            ),
            
            AccessToken = TokenResponse[access_token]
        in
            AccessToken,
    
    // Get the bearer token once for all API calls
    BearerToken = GetBearerToken(),
    
    // ===== HELPER FUNCTIONS =====
    
    // Function to make authenticated API calls
    MakeApiCall = (url as text, optional body as text) =>
        let
            headers = [
                #"Authorization" = "Bearer " & BearerToken,
                #"Content-Type" = "application/json"
            ],
            options = if body <> null then
                [Headers = headers, Content = Text.ToBinary(body)]
            else
                [Headers = headers],
            response = Web.Contents(url, options)
        in
            Json.Document(response),
    
    // Function to wait for job completion
    WaitForJobCompletion = (jobId as text) =>
        let
            StatusUrl = "https://" & CriblConfig[Instance] & "/api/v1/search/jobs/" & jobId,
            
            CheckStatus = () =>
                let
                    status = MakeApiCall(StatusUrl, null),
                    currentStatus = status[status]
                in
                    if currentStatus = "finished" then
                        status
                    else if currentStatus = "failed" or currentStatus = "cancelled" then
                        error "Search job " & currentStatus & ": " & (status[error]? ?? "Unknown error")
                    else
                        Function.InvokeAfter(
                            () => CheckStatus(),
                            #duration(0, 0, 0, CriblConfig[PollInterval])
                        )
        in
            CheckStatus(),
    
    // ===== MAIN SEARCH WORKFLOW =====
    
    // Step 1: Create search job
    CreateJobUrl = "https://" & CriblConfig[Instance] & "/api/v1/search/jobs",
    SearchPayload = Json.FromValue([
        query = CriblConfig[Query],
        earliest = CriblConfig[Earliest],
        latest = CriblConfig[Latest],
        limit = CriblConfig[MaxResults]
    ]),
    
    JobResponse = MakeApiCall(CreateJobUrl, SearchPayload),
    JobId = JobResponse[id],
    
    // Step 2: Wait for completion
    CompletedJob = WaitForJobCompletion(JobId),
    
    // Step 3: Fetch results
    ResultsUrl = "https://" & CriblConfig[Instance] & "/api/v1/search/jobs/" & JobId & "/results",
    ResultsResponse = MakeApiCall(ResultsUrl, null),
    
    // Step 4: Parse and transform results
    Results = ResultsResponse[results],
    
    // Convert results to table
    ResultsTable = if List.Count(Results) > 0 then
        let
            // Get all unique field names across all records
            AllFields = List.Distinct(
                List.Combine(
                    List.Transform(Results, each Record.FieldNames(_))
                )
            ),
            
            // Create table with all fields
            Table = Table.FromRecords(Results, AllFields, MissingField.UseNull),
            
            // Auto-detect and set column types
            TypedTable = Table.TransformColumnTypes(
                Table,
                List.Transform(
                    AllFields,
                    each {_, type any}
                )
            )
        in
            TypedTable
    else
        #table({}, {}),  // Empty table if no results
    
    // Step 5: Add metadata columns
    FinalTable = Table.AddColumn(
        ResultsTable, 
        "_search_metadata", 
        each [
            JobId = JobId,
            Dataset = CriblConfig[Dataset],
            Query = CriblConfig[Query],
            TimeRange = CriblConfig[Earliest] & " to " & CriblConfig[Latest],
            ResultCount = Table.RowCount(ResultsTable),
            ExecutionTime = CompletedJob[executionTime]?,
            SearchTimestamp = DateTime.LocalNow()
        ],
        type record
    )
    
in
    FinalTable
```

### Simplified Query for Basic Use

For simpler use cases, use this minimal query (still using Blank Query, not Web):

```powerquery
let
    // Configuration
    BaseUrl = "https://YOUR_INSTANCE.cribl.cloud",
    ClientId = "YOUR_CLIENT_ID",
    ClientSecret = "YOUR_CLIENT_SECRET",
    
    // Get Bearer Token
    TokenResponse = Json.Document(
        Web.Contents(
            BaseUrl & "/api/v1/auth/token",
            [
                Headers = [#"Content-Type" = "application/json"],
                Content = Text.ToBinary(Json.FromValue([
                    grant_type = "client_credentials",
                    client_id = ClientId,
                    client_secret = ClientSecret,
                    audience = BaseUrl
                ]))
            ]
        )
    ),
    
    Token = TokenResponse[access_token],
    
    // Create and execute search
    Source = Json.Document(
        Web.Contents(
            BaseUrl & "/api/v1/search/jobs",
            [
                Headers = [
                    #"Authorization" = "Bearer " & Token,
                    #"Content-Type" = "application/json"
                ],
                Content = Text.ToBinary("{
                    ""query"": ""dataset='YOUR_DATASET' | limit 100"",
                    ""earliest"": ""-1h"",
                    ""latest"": ""now""
                }")
            ]
        )
    ),
    
    JobId = Source[id],
    
    // Get results (simplified - doesn't wait for completion)
    Results = Json.Document(
        Web.Contents(
            BaseUrl & "/api/v1/search/jobs/" & JobId & "/results",
            [Headers = [#"Authorization" = "Bearer " & Token]]
        )
    ),
    
    ConvertedToTable = Table.FromRecords(Results[results])
in
    ConvertedToTable
```

## Step 5: Transform and Load Data

### Data Type Detection

PowerBI should auto-detect most data types, but you may need to:

1. Right-click column headers to change data types
2. Common transformations:
   - `_time` → DateTime
   - Numeric fields → Decimal/Int64
   - JSON fields → Text or Record

### Creating Relationships

If loading multiple datasets:

1. Load each dataset using separate queries
2. Go to **Model** view
3. Create relationships between common fields (e.g., host, source)

### Incremental Refresh Setup

For large datasets, configure incremental refresh:

1. Create parameters:
   - `RangeStart` (DateTime)
   - `RangeEnd` (DateTime)
2. Modify query to use parameters:
```powerquery
earliest = DateTime.ToText(RangeStart, "yyyy-MM-dd'T'HH:mm:ss"),
latest = DateTime.ToText(RangeEnd, "yyyy-MM-dd'T'HH:mm:ss")
```
3. Configure incremental refresh policy in dataset settings

## Troubleshooting

### Common Issues and Solutions

| Issue | Solution |
|-------|----------|
| **Authentication Failed** | Verify Client ID/Secret are correct and have proper permissions |
| **Timeout Errors** | Increase timeout in query or reduce data range |
| **Missing Fields** | Check if fields exist in dataset, adjust query |
| **Rate Limiting** | Add delays between requests, use pagination |
| **SSL/TLS Errors** | Update PowerBI, check certificate trust |

### Debug Mode Query

Use this query to debug connection issues:

```powerquery
let
    // Configuration
    Instance = "YOUR_INSTANCE.cribl.cloud",
    ClientId = "YOUR_CLIENT_ID",
    ClientSecret = "YOUR_CLIENT_SECRET",
    
    // Try to get token
    TokenResult = try
        let
            TokenUrl = "https://" & Instance & "/api/v1/auth/token",
            TokenBody = Json.FromValue([
                grant_type = "client_credentials",
                client_id = ClientId,
                client_secret = ClientSecret,
                audience = "https://" & Instance
            ]),
            TokenResponse = Json.Document(
                Web.Contents(
                    TokenUrl,
                    [
                        Headers = [#"Content-Type" = "application/json"],
                        Content = Text.ToBinary(TokenBody)
                    ]
                )
            )
        in
            TokenResponse
    otherwise
        [Error = "Token exchange failed", Message = "Check Client ID and Secret"],
    
    // If token obtained, test API
    DebugResponse = if Record.HasFields(TokenResult, "access_token") then
        try
            Json.Document(
                Web.Contents(
                    "https://" & Instance & "/api/v1/system/info",
                    [Headers = [#"Authorization" = "Bearer " & TokenResult[access_token]]]
                )
            )
        otherwise
            [Error = "API call failed", Message = "Token valid but API unreachable"]
    else
        TokenResult
in
    DebugResponse
```

### Testing Datasets Access

To verify which datasets are available, create another query:

```powerquery
let
    // UPDATE THESE VALUES (same as test query)
    CriblInstance = "YOUR_INSTANCE.cribl.cloud",
    ClientId = "YOUR_CLIENT_ID",
    ClientSecret = "YOUR_CLIENT_SECRET",
    
    // Get Bearer Token
    TokenResponse = Json.Document(
        Web.Contents(
            "https://" & CriblInstance & "/api/v1/auth/token",
            [
                Headers = [#"Content-Type" = "application/json"],
                Content = Text.ToBinary(Json.FromValue([
                    grant_type = "client_credentials",
                    client_id = ClientId,
                    client_secret = ClientSecret,
                    audience = "https://" & CriblInstance
                ]))
            ]
        )
    ),
    
    BearerToken = TokenResponse[access_token],
    
    // List available datasets
    DatasetsResponse = Json.Document(
        Web.Contents(
            "https://" & CriblInstance & "/api/v1/search/datasets",
            [Headers = [#"Authorization" = "Bearer " & BearerToken]]
        )
    ),
    
    // Convert to table
    DatasetsList = DatasetsResponse[items],
    DatasetsTable = Table.FromList(DatasetsList, Splitter.SplitByNothing(), null, null, ExtraValues.Error),
    ExpandedTable = Table.ExpandRecordColumn(DatasetsTable, "Column1", {"id", "description"}, {"Dataset ID", "Description"})
in
    ExpandedTable
```

## Example Queries

### Basic Event Search
```
dataset="web_logs" 
| where status >= 400 
| stats count() by status
```

### Time-based Aggregation
```
dataset="metrics" 
| bin _time span=5m 
| stats avg(cpu) as avg_cpu, max(memory) as max_memory by _time, host
```

### Join Multiple Datasets
```
dataset="app_logs" 
| join type=inner host [
    search dataset="metrics" 
    | stats avg(cpu) as avg_cpu by host
]
```

### Field Extraction and Parsing
```
dataset="raw_logs" 
| rex field=_raw "(?<ip>\d+\.\d+\.\d+\.\d+)" 
| stats count() by ip 
| sort -count
```

## Best Practices

1. **Use Query Parameters**: Create PowerBI parameters for reusable values
2. **Implement Caching**: Set appropriate refresh schedules
3. **Optimize Queries**: Use Cribl Search optimizations (stats, where clauses)
4. **Monitor Performance**: Check job execution times in Cribl UI
5. **Handle Errors Gracefully**: Implement try-catch blocks in M queries
6. **Secure Credentials**: Use PowerBI parameters or Azure Key Vault for Client ID/Secret
7. **Document Queries**: Add comments to complex M queries

## Additional Resources

- [Cribl Search Documentation](https://docs.cribl.io/stream/search/)
- [PowerBI Web Connector Guide](https://docs.microsoft.com/en-us/power-bi/connect-data/desktop-connect-to-web)
- [Power Query M Language Reference](https://docs.microsoft.com/en-us/powerquery-m/)
- [Cribl API Reference](https://docs.cribl.io/api/)

## Support

For issues specific to:
- **Cribl Search API**: Contact Cribl Support or check [Cribl Community](https://community.cribl.io)
- **PowerBI**: Check [PowerBI Community](https://community.powerbi.com)
- **This Integration**: Open an issue in this repository

---

*Last updated: 2025*
*Version: 1.0.0*