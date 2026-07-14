# Active Directory to Cribl Cloud Lookup Sync Script

This Python script queries an Active Directory (AD) server for user information, exports the results to a CSV file, and uploads the file to Cribl Cloud as a lookup table. It supports both creating new lookup objects and updating existing ones, followed by committing and deploying changes to a specified Cribl worker group.

## Features

- **AD Query**: Retrieves user attributes (`sAMAccountName`, `DisplayName`, `EmailAddress`, `Department`, `Title`) from an AD server via LDAP.
- **CSV Export**: Saves query results to a CSV file.
- **Cribl Cloud Integration**: Authenticates with Cribl Cloud, uploads the CSV, manages lookup objects, and deploys changes.
- **Flexible Configuration**: Supports configuration via a `config.ini` file or command-line arguments.
- **User-Friendly AD Credentials**: Accepts AD user input in UPN (`joe@mycompany.com`), NetBIOS (`MYDOMAIN\joe`), or plain username (`joe`) formats.
- **Robust Error Handling**: Provides clear error messages for configuration issues and API failures.

## Prerequisites

- **Python**: Version 3.7 or higher.
- **Dependencies**: Install required libraries listed in `requirements.txt`.
- **Active Directory Access**: Access to an AD server with LDAP enabled (port 389 or 636 for LDAPS).
- **Cribl Cloud Account**: Credentials (client ID and secret) for Cribl Cloud API access.
- **Network Access**: Ability to connect to the AD server and Cribl Cloud APIs (`https://login.cribl.cloud`, `https://app.cribl.cloud`).

## Installation

1. **Clone or Download the Script**:

   - Save `main.py`, `requirements.txt`, and an optional `config.ini` to a directory.

2. **Set Up a Virtual Environment** (recommended):

   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. **Install Dependencies**:

   ```bash
   pip install -r requirements.txt
   ```

4. **Create a Configuration File** (optional):

   - Copy the example `config.ini` below to a file named `config.ini` in the same directory as `main.py`.

## Configuration

The script supports configuration via a `config.ini` file or command-line arguments. Command-line arguments override `config.ini` values.

### Example `config.ini`

```ini
[cribl]
client_id = your_client_id
client_secret = your_client_secret
organization_id = your_org_id
lookup_filename = users.csv
target_worker_group = default
ad_server = ldap://ad.mycompany.com
ad_user = joe@mycompany.com
ad_password = your_password
ad_domain = mycompany.com
# ad_search_domain = child.mycompany.com  # Optional, only if search base differs
```

### Configuration Fields

- `client_id`, `client_secret`: Cribl Cloud API credentials (obtain from Cribl Cloud admin).
- `organization_id`: Your Cribl Cloud organization ID.
- `lookup_filename`: Name of the CSV file to generate and upload (e.g., `users.csv`).
- `target_worker_group`: Cribl worker group to upload the lookup to (e.g., `default`).
- `ad_server`: AD server address (e.g., `ldap://ad.mycompany.com` or `ldaps://ad.mycompany.com:636`).
- `ad_user`: AD user for authentication, in one of:
  - UPN format: `joe@mycompany.com`
  - NetBIOS format: `MYDOMAIN\joe` or `MYDOMAIN/joe`
  - Plain username: `joe` (requires `ad_domain`)
- `ad_password`: Password for the AD user.
- `ad_domain`: AD domain for authentication and search base (e.g., `mycompany.com` or `MYDOMAIN`).
- `ad_search_domain`: Optional, use if the search base domain differs from `ad_domain` (e.g., `child.mycompany.com`).

### Security Note

- Avoid storing `ad_password` or Cribl credentials in plain text. Consider using environment variables or a secrets manager.

- Example using environment variables:

  ```python
  import os
  ad_password = os.getenv("AD_PASSWORD", config["ad_password"])
  ```

## Usage

Run the script via the command line, specifying configuration via `config.ini` or arguments.

### Using `config.ini`

```bash
python main.py
```

### Using Command-Line Arguments

```bash
python main.py \
  --ad-server ldap://ad.mycompany.com \
  --ad-user joe@mycompany.com \
  --ad-password secret \
  --ad-domain mycompany.com \
  --client-id your_client_id \
  --client-secret your_client_secret \
  --organization-id your_org_id \
  --lookup-filename users.csv \
  --target-group default
```

### Example with Different Search Domain

```bash
python main.py \
  --ad-server ldap://ad.mycompany.com \
  --ad-user MYDOMAIN\joe \
  --ad-password secret \
  --ad-domain mycompany.com \
  --ad-search-domain child.mycompany.com \
  --lookup-filename users.csv
```

## Workflow

1. **Parse Arguments and Config**: Loads settings from `config.ini` and overrides with command-line arguments.
2. **Query AD**: Connects to the AD server, queries user attributes, and exports to a CSV file.
3. **Cribl Cloud Authentication**: Obtains a bearer token using Cribl client credentials.
4. **Upload CSV**: Uploads the CSV to the specified Cribl worker group.
5. **Manage Lookup**: Creates a new lookup object or updates an existing one.
6. **Commit and Deploy**: Commits changes and deploys them to Cribl Cloud.

## Testing

To test the script:

1. **Set Up a Test AD Environment**:

   - Use a Windows Server trial with Active Directory Domain Services (AD DS) in a VM (e.g., VirtualBox).
   - Populate with test users using PowerShell or tools like Albus Bit’s AD Test Data Generator.

2. **Create a Test** `config.ini`:

   ```ini
   [cribl]
   ad_server = ldap://192.168.56.10
   ad_user = Administrator@testlab.local
   ad_password = Password123!
   ad_domain = testlab.local
   lookup_filename = test_users.csv
   ```

3. **Run with Dummy Cribl Credentials**:

   - For AD-only testing, comment out Cribl-related code in `main()` (lines after `query_ad_users`).
   - Run: `python main.py`
   - Verify that `test_users.csv` contains the expected user data.

4. **Test Cribl Integration**:

   - Use valid Cribl Cloud credentials and ensure network access to `https://app.cribl.cloud`.
   - Check Cribl Cloud UI to confirm the lookup table is created/updated.

## Troubleshooting

- **AD Connection Errors**:

  - Verify `ad_server` is reachable (`ping` or `telnet ad.mycompany.com 389`).
  - Ensure `ad_user` has permission to query AD.
  - Check `ad_domain` matches the AD domain (e.g., `mycompany.com`).
  - For LDAPS, use `ldaps://` and port 636, and ensure the server certificate is trusted.

- **Invalid User Format**:

  - Ensure `ad_user` is valid (e.g., `joe@mycompany.com`, `MYDOMAIN\joe`, or `joe` with `ad_domain`).
  - Check error messages for guidance (e.g., `Configuration error: AD domain must be specified when using plain username: joe`).

- **Cribl API Errors**:

  - Verify `client_id`, `client_secret`, and `organization_id`.
  - Ensure network access to Cribl Cloud APIs.
  - Check response messages for HTTP status codes or API errors.

- **CSV Issues**:

  - Ensure `lookup_filename` ends with `.csv`.
  - Verify write permissions in the script’s directory.

## Security Considerations

- **Credentials**: Store `ad_password`, `client_id`, and `client_secret` securely (e.g., environment variables, AWS Secrets Manager).
- **LDAPS**: Prefer `ldaps://` over `ldap://` to encrypt AD communication.
- **File Permissions**: Restrict access to `config.ini` and the generated CSV file.
- **API Tokens**: Handle Cribl bearer tokens securely and avoid logging them.

## Extensibility

- **Additional AD Attributes**: Modify the `attributes` list in `query_ad_users` to include other AD fields (e.g., `telephoneNumber`, `lastLogon`).
- **Logging**: Add Python’s `logging` module for detailed debug output.
- **Scheduling**: Use a scheduler like `cron` or `Windows Task Scheduler` to run the script periodically.
- **Multi-Domain Support**: Extend `ad_search_domain` to support querying multiple domains or organizational units.

## License

This script is provided as-is for educational and testing purposes. Ensure compliance with your organization’s policies and Cribl’s terms of service.

## Contact

For issues or feature requests, please contact ssimmons@cribl.io.
