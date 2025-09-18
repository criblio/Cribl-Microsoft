// Cribl Search API - PowerBI Query Template with Client Credentials
// 
// IMPORTANT: This query MUST be used with Get Data > Blank Query
//           DO NOT use Get Data > Web (it cannot handle OAuth2 authentication)
//
// Instructions:
// 1. In PowerBI Desktop, click "Get Data"
// 2. Search for "Blank Query" (NOT "Web"!)
// 3. Click "Connect"
// 4. Right-click "Query1" in the Power Query Editor
// 5. Select "Advanced Editor"
// 6. Replace ALL content with this code
// 7. Update the configuration values below
// 8. Click "Done" and then "Close & Apply"

let
    // ========================================
    // CONFIGURATION - UPDATE THESE VALUES
    // ========================================
    CriblInstance = "YOUR_INSTANCE.cribl.cloud",  // e.g., "acme.cribl.cloud"
    ClientId = "YOUR_CLIENT_ID",                  // Your Cribl Client ID
    ClientSecret = "YOUR_CLIENT_SECRET",          // Your Cribl Client Secret
    DatasetId = "YOUR_DATASET",                   // e.g., "web_logs"
    SearchQuery = "dataset=""YOUR_DATASET"" | head 1000",  // Your search query
    TimeRangeStart = "-24h",                      // e.g., "-24h", "-7d", "2024-01-01T00:00:00Z"
    TimeRangeEnd = "now",                          // e.g., "now", "2024-01-02T00:00:00Z"
    
    // ========================================
    // AUTHENTICATION (DO NOT MODIFY)
    // ========================================
    // This section exchanges your Client ID/Secret for a bearer token
    // The Web connector cannot do this, which is why we use Blank Query
    
    BaseUrl = "https://" & CriblInstance,
    
    // Get Bearer Token from Client Credentials
    TokenBody = Json.FromValue([
        grant_type = "client_credentials",
        client_id = ClientId,
        client_secret = ClientSecret,
        audience = BaseUrl
    ]),
    
    TokenResponse = Json.Document(
        Web.Contents(
            BaseUrl & "/api/v1/auth/token",
            [
                Headers = [#"Content-Type" = "application/json"],
                Content = Text.ToBinary(TokenBody)
            ]
        )
    ),
    
    BearerToken = TokenResponse[access_token],
    
    // Headers for authenticated requests
    Headers = [
        #"Authorization" = "Bearer " & BearerToken,
        #"Content-Type" = "application/json"
    ],
    
    // ========================================
    // SEARCH EXECUTION (DO NOT MODIFY)
    // ========================================
    
    // Create search job
    CreateJobBody = Json.FromValue([
        query = SearchQuery,
        earliest = TimeRangeStart,
        latest = TimeRangeEnd
    ]),
    
    JobResponse = Json.Document(
        Web.Contents(
            BaseUrl & "/api/v1/search/jobs",
            [
                Headers = Headers,
                Content = Text.ToBinary(CreateJobBody)
            ]
        )
    ),
    
    JobId = JobResponse[id],
    
    // Poll for completion (simplified - may need adjustment for long-running queries)
    WaitAndGetStatus = 
        let
            // Wait 3 seconds then check status
            Wait = Function.InvokeAfter(() => true, #duration(0,0,0,3)),
            Status = Json.Document(
                Web.Contents(
                    BaseUrl & "/api/v1/search/jobs/" & JobId,
                    [Headers = Headers]
                )
            )
        in
            Status,
    
    // Get results
    Results = 
        if WaitAndGetStatus[status] = "finished" then
            Json.Document(
                Web.Contents(
                    BaseUrl & "/api/v1/search/jobs/" & JobId & "/results",
                    [Headers = Headers]
                )
            )
        else
            error "Job not completed. Status: " & WaitAndGetStatus[status],
    
    // Convert to table
    ResultsList = Results[results],
    FinalTable = 
        if List.Count(ResultsList) > 0 then
            Table.FromRecords(ResultsList)
        else
            #table({}, {})
in
    FinalTable