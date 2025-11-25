# QuickStart Guide: Cribl Search API in Power BI

This guide walks you through connecting Power BI to the Cribl Search API using Python scripting to query and visualize your Cribl data.

## Prerequisites

### 1. Software Requirements

- **Power BI Desktop** (Windows only)
- **Python 3.8+** installed locally
- Required Python packages:
  ```
  pip install requests pandas
  ```

### 2. Cribl Cloud Requirements

- Active Cribl Cloud account with Search enabled
- API credentials (Client ID and Client Secret)
- Organization ID
- Workspace name (typically `main`)

## Step 1: Obtain Cribl API Credentials

1. Log into [Cribl Cloud](https://cribl.cloud)
2. Navigate to **Settings** > **Organization** > **Access Management** > **API Credentials**
3. Click **Add Credential**
4. Provide a description (e.g., "Power BI Integration")
5. Copy and securely store:
   - **Client ID**
   - **Client Secret** (shown only once)
6. Note your **Organization ID** from the URL: `https://<org_id>.cribl.cloud`

## Step 2: Configure Power BI for Python

1. Open **Power BI Desktop**
2. Go to **File** > **Options and settings** > **Options**
3. Select **Python scripting** under Global
4. Set the **Python home directory** to your Python installation path
   - Example: `C:\Users\<username>\AppData\Local\Programs\Python\Python311`
5. Click **OK**

## Step 3: Add Python Script Data Source

1. In Power BI Desktop, click **Home** > **Get Data** > **More...**
2. Search for and select **Python script**
3. Click **Connect**

## Step 4: Configure the Script

Copy the script from [PowerBI_CriblSearch.py](PowerBI_CriblSearch.py) and modify the configuration section:

```python
# ==================== CONFIGURATION ====================
# Replace these with your actual Cribl credentials
client_id = "<YOUR_CLIENT_ID_HERE>"
client_secret = "<YOUR_CLIENT_SECRET_HERE>"
org_id = "<YOUR_ORG_ID_HERE>"  # Example: main-busy-yonath-kz1bxn7
workspace = "YOUR WORKSPACE NAME>"  # Your workspace name

# Query configuration
dataset = "<YOUR DATASET NAME>"  # Dataset to query
query = f'cribl dataset="{dataset}" | limit 10'  # Customize your Cribl query here
earliest = "-1h"  # Time range start (e.g., -1h, -24h, -7d)
latest = "now"  # Time range end

# Output configuration
output_name = "<YOUR POWERBI DATASET NAME>"  # Name of the dataset in Power BI
```

### Configuration Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `client_id` | Your Cribl API Client ID | `abc123...` |
| `client_secret` | Your Cribl API Client Secret | `xyz789...` |
| `org_id` | Your Cribl Cloud Organization ID | `main-busy-yonath-kz1bxn7` |
| `workspace` | Cribl Search workspace name | `default_search` |
| `dataset` | Dataset to query | `Corelight`, `aws_cloudtrail` |
| `query` | Cribl Search query | `cribl dataset="Corelight" \| limit 100` |
| `earliest` | Start of time range | `-1h`, `-24h`, `-7d`, `-30d` |
| `latest` | End of time range | `now`, `-1h` |
| `output_name` | DataFrame name for Power BI | `Corelight` |

## Step 5: Run and Load Data

1. Paste the configured script into the Python script dialog
2. Click **OK**
3. Power BI will execute the script and display available tables
4. Select the `cribl_data` table (or your custom `output_name`)
5. Click **Load** to import the data

## Step 6: Build Your Report

Once loaded, you can:
- Create visualizations using the imported data
- Apply filters and transformations
- Schedule data refresh (Power BI Service with gateway)

## Example Queries

### Query All Data from a Dataset (Limited)
```python
query = 'cribl dataset="Corelight" | limit 1000'
```

### Filter by Specific Field
```python
query = 'cribl dataset="Corelight" | where service=="dns" | limit 500'
```

### Aggregate Data
```python
query = 'cribl dataset="Corelight" | stats count() by service'
```

### Time-Based Analysis
```python
query = 'cribl dataset="Corelight" | timechart count() by service span=1h'
earliest = "-24h"
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| **"No module named 'requests'"** | Run `pip install requests pandas` in your Python environment |
| **Authentication Error** | Verify Client ID and Client Secret are correct |
| **"Search job failed"** | Check query syntax and dataset name |
| **Empty Results** | Verify time range contains data; try expanding `earliest` |
| **Timeout** | Increase `max_attempts` or simplify query |

### Debug Mode

Add this code before the configuration section to see detailed output:

```python
import sys
print(f"Python version: {sys.version}")
print(f"Script starting...")
```

### Verify API Connectivity

Test your credentials outside Power BI first:

```python
# Save as test_cribl_api.py and run from command line
import requests

client_id = "YOUR_CLIENT_ID"
client_secret = "YOUR_CLIENT_SECRET"

response = requests.post(
    "https://login.cribl.cloud/oauth/token",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    data={
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "audience": "https://api.cribl.cloud"
    }
)

if response.status_code == 200:
    print("Authentication successful!")
else:
    print(f"Error: {response.status_code}")
    print(response.text)
```

## Security Best Practices

1. **Never share scripts containing credentials** - Use environment variables or Power BI parameters for production
2. **Use least-privilege API credentials** - Create dedicated read-only credentials for Power BI
3. **Rotate credentials regularly** - Update Client Secret periodically
4. **Limit query scope** - Use specific datasets and time ranges to minimize data exposure

## Advanced: Using Power BI Parameters

For enhanced security, store credentials as Power BI parameters:

1. Go to **Home** > **Transform data** > **Edit Parameters**
2. Create parameters for `client_id`, `client_secret`, `org_id`
3. Reference in script using Power Query M integration

## Data Refresh

### Manual Refresh
Click **Refresh** in Power BI Desktop to re-run the Python script.

### Scheduled Refresh (Power BI Service)
Requires:
- Power BI Pro or Premium license
- On-premises data gateway with Python support
- Gateway configured with Python runtime

## Additional Resources

- [Cribl Search Documentation](https://docs.cribl.io/search/)
- [Cribl API Reference](https://docs.cribl.io/api/)
- [Power BI Python Scripting](https://docs.microsoft.com/en-us/power-bi/connect-data/desktop-python-scripts)
