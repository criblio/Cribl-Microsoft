"""
Cribl Search API to Power BI Data Connector
============================================
This script connects to Cribl Cloud Search API and retrieves data for use in Power BI.

SETUP INSTRUCTIONS:
1. Replace the placeholder values in the Configuration section below with your actual credentials
2. Adjust query parameters as needed for your use case
3. Run in Power BI Desktop: Home -> Get Data -> Python script -> paste this code

REQUIRED PYTHON PACKAGES:
- requests
- pandas

Install with: pip install requests pandas matplotlib
"""

import requests
import pandas as pd
import time
import json

# ==================== CONFIGURATION ====================
# Replace these with your actual Cribl credentials
client_id = "<YOUR_CLIENT_ID_HERE>"
client_secret = "<YOUR_CLIENT_SECRET_HERE>"
org_id = "<YOUR_ORG_ID_HERE>"  # Example: main-busy-yonath-kz1bxn7
workspace = "<YOUR WORKSPACE NAME>"  # Your workspace name

# Query configuration
dataset = "<YOUR DATASET NAME>"  # Dataset to query
query = f'cribl dataset="{dataset}" | limit 10'  # Customize your Cribl query here
earliest = "-1h"  # Time range start (e.g., -1h, -24h, -7d)
latest = "now"  # Time range end

# Output configuration
output_name = "<YOUR POWERBI DATASET NAME>"  # Name of the dataset in Power BI

# Columns to exclude from results
columns_to_remove = ['isFinished', 'offset', 'persistedEventCount', 'totalEventCount', 'job']
# ======================================================

# Construct base URL
base_url = f"https://{org_id}.cribl.cloud/api/v1/m/{workspace}"

# Get OAuth token with audience
token_response = requests.post(
    "https://login.cribl.cloud/oauth/token",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    data={
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "audience": "https://api.cribl.cloud"
    }
)

access_token = token_response.json()["access_token"]

# Submit search job
search_response = requests.post(
    f"{base_url}/search/jobs",
    headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {access_token}"
    },
    json={
        "query": query,
        "earliest": earliest,
        "latest": latest,
        "sampleRate": 1
    }
)

job_id = search_response.json()["items"][0]["id"]

# Wait for job to complete by checking status
max_attempts = 60
for attempt in range(max_attempts):
    status_response = requests.get(
        f"{base_url}/search/jobs/{job_id}",
        headers={"Authorization": f"Bearer {access_token}"}
    )
    
    job_status = status_response.json()["items"][0]["status"]
    
    if job_status in ["done", "completed"]:
        break
    elif job_status == "failed":
        raise Exception("Search job failed")
    
    time.sleep(2)

# Get results
results_response = requests.get(
    f"{base_url}/search/jobs/{job_id}/results",
    headers={"Authorization": f"Bearer {access_token}"}
)

# Parse NDJSON (newline-delimited JSON)
results = []
for line in results_response.text.strip().split('\n'):
    if line.strip():  # Check if line is not empty
        parsed = json.loads(line)
        if parsed:  # Check if parsed object is not empty
            results.append(parsed)

# Convert to DataFrame for Power BI
df_temp = pd.DataFrame(results)

# Remove unwanted columns
df_temp = df_temp.drop(columns=columns_to_remove, errors='ignore')

# Remove any rows that are completely empty
df_temp = df_temp.dropna(how='all')

# Assign to the variable name specified in output_name
globals()[output_name] = df_temp

# Delete the temp variable so only the named one appears in Power BI
del df_temp