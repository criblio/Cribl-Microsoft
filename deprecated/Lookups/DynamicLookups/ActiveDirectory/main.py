import requests
import gzip
import argparse
import csv
from ldap3 import Server, Connection, ALL
from pathlib import Path
import configparser


''' 1. Parse command-line arguments.
    2. Parse config file, if it exists.
    3. Overwrite config with command-line args.
    4. Query Active Directory for user information.
    5. Export the results to a CSV file.
    6. Get a Cribl Cloud bearer token.
    7. Upload the CSV file to Cribl Cloud.
    8. Check for existing lookup file on target worker group.
    9. Create lookup object if it doesn't exist, or update if it does.
    10. Commit the changes to Cribl Cloud.
    11. Deploy changes to Cribl Cloud.'''


def parse_arguments():
    parser = argparse.ArgumentParser(
        description="Transfer lookup files between Cribl worker groups",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument(
        "--config",
        type=Path,
        default="config.ini",
        help="Path to configuration file"
    )
    parser.add_argument(
        "--client-id",
        help="Cribl client ID (overrides config file)"
    )
    parser.add_argument(
        "--client-secret",
        help="Cribl client secret (overrides config file)"
    )
    parser.add_argument(
        "--organization-id",
        help="Cribl.cloud organization ID (overrides config file)"
    )
    parser.add_argument(
        "--lookup-filename",
        help="Lookup file name (overrides config file)"
    )
    parser.add_argument(
        "--ad-server",
        help="Active Directory server address (e.g., ldap://your-ad-server)"
    )
    parser.add_argument(
        "--ad-user",
        help="AD user (e.g., joe@mycompany.com, MYDOMAIN\\joe, or joe)"
    )
    parser.add_argument(
        "--ad-password",
        help="Active Directory password"
    )
    parser.add_argument(
        "--ad-domain",
        help="AD domain (e.g., mycompany.com or MYDOMAIN), used for both authentication and search base"
    )
    parser.add_argument(
        "--ad-search-domain",
        help="AD domain for search base if different from ad-domain (e.g., child.mycompany.com)"
    )
    parser.add_argument(
        "--target-group",
        help="Target worker group (overrides config file)"
    )

    return parser.parse_args()


def load_config(config_path):
    config = configparser.ConfigParser()
    defaults = {
        "cribl": {
            "client_id": "",
            "client_secret": "",
            "organization_id": "",
            "lookup_filename": "",
            "target_worker_group": "default",
            "ad_server": "",
            "ad_user": "",
            "ad_password": "",
            "ad_domain": "",
            "ad_search_domain": "",
        }
    }
    config.read_dict(defaults)

    if config_path.exists():
        config.read(config_path)

    return config["cribl"]


def parse_ad_user(ad_user, ad_domain):
    """Parse ad_user input to extract username and domain."""
    if not ad_user:
        raise ValueError("AD user must be specified in config or arguments")

    # Remove leading/trailing whitespace
    ad_user = ad_user.strip()

    # Handle UPN format (joe@mycompany.com)
    if '@' in ad_user:
        username, user_domain = ad_user.split('@', 1)
        if not username:
            raise ValueError(f"Invalid AD user format: {ad_user}. Username cannot be empty.")
        return username, user_domain or ad_domain

    # Handle NetBIOS format (MYDOMAIN\joe or MYDOMAIN/joe)
    if '\\' in ad_user or '/' in ad_user:
        separator = '\\' if '\\' in ad_user else '/'
        user_domain, username = ad_user.split(separator, 1)
        if not username:
            raise ValueError(f"Invalid AD user format: {ad_user}. Username cannot be empty.")
        return username, user_domain or ad_domain

    # Handle plain username (joe)
    if not ad_domain:
        raise ValueError(f"AD domain must be specified when using plain username: {ad_user}")
    return ad_user, ad_domain


def query_ad_users(ad_server, ad_user, ad_password, ad_domain, ad_search_domain, output_file):
    """Query AD users and export to CSV."""
    try:
        # Parse ad_user to extract username and domain
        username, user_domain = parse_ad_user(ad_user, ad_domain)

        # Construct full username for authentication
        if user_domain:
            # Prefer UPN format (username@domain) as it's more universal
            full_username = f"{username}@{user_domain}"
        else:
            full_username = username

        # Use ad_search_domain if provided, otherwise fall back to ad_domain
        search_domain = ad_search_domain or ad_domain
        if not search_domain:
            raise ValueError("AD domain or search domain must be specified in config or arguments")

        # Construct the search_base (e.g., mycompany.com -> dc=mycompany,dc=com)
        dc_components = search_domain.split('.')
        search_base = ','.join(f"dc={component}" for component in dc_components)

        # Validate inputs
        if not ad_server:
            raise ValueError("AD server must be specified in config or arguments")
        if not ad_password:
            raise ValueError("AD password must be specified in config or arguments")

        # Initialize LDAP server and connection
        server = Server(ad_server, get_info=ALL)
        conn = Connection(server, user=full_username, password=ad_password, auto_bind=True)

        # Search for users
        conn.search(
            search_base=search_base,
            search_filter='(objectClass=user)',
            attributes=['sAMAccountName', 'DisplayName', 'EmailAddress', 'Department', 'Title']
        )

        # Write to CSV
        with open(output_file, 'w', newline='') as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(['sAMAccountName', 'DisplayName', 'EmailAddress', 'Department', 'Title'])
            for entry in conn.entries:
                writer.writerow([
                    entry.sAMAccountName.value or '',
                    entry.DisplayName.value or '',
                    entry.EmailAddress.value or '',
                    entry.Department.value or '',
                    entry.Title.value or ''
                ])

        print(f"AD user data exported to {output_file}")
        conn.unbind()

    except ValueError as e:
        print(f"Configuration error: {str(e)}")
        exit(1)
    except Exception as e:
        print(f"Error querying AD: {str(e)}")
        exit(1)


def get_bearer_token(client_id, client_secret):
    if not client_id or not client_secret:
        raise ValueError("CRIBL_CLIENT_ID and CRIBL_CLIENT_SECRET must be provided via arguments or configuration file.")
    
    url = "https://login.cribl.cloud/oauth/token"
    headers = {"Content-Type": "application/json"}
    payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "audience": "https://api.cribl.cloud"
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()["access_token"]
    except requests.exceptions.RequestException as e:
        print(f"Failed to obtain bearer token: {e}")
        return None


def check_lookup_exists(token, organization_id, worker_group, lookup_filename):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/m/{worker_group}/system/lookups/{lookup_filename}"
    headers = {
        "accept": "application/json",
        "Authorization": f"Bearer {token}"
    }
    
    try:
        response = requests.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        
        if not data or "items" not in data or not data["items"]:
            return False
        return any(item.get("id") == lookup_filename for item in data["items"])
    
    except requests.exceptions.RequestException as e:
        print(f"Failed to check if lookup '{lookup_filename}' exists in {worker_group}: {e}")
        return False


def upload_lookup_file(token, organization_id, worker_group, lookup_filename):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/m/{worker_group}/system/lookups?filename={lookup_filename}"
    content_type = "text/csv" if lookup_filename.endswith('.csv') else "application/gzip"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-type": content_type,
        "accept": "application/json"
    }
    
    try:
        # Open file in appropriate mode based on extension
        open_func = gzip.open if lookup_filename.endswith('.gz') else open
        mode = 'rb'

        with open_func(lookup_filename, mode) as f:
            response = requests.put(url, headers=headers, data=f)
        response.raise_for_status()
        
        response_data = response.json()

        temp_filename = response_data.get("filename")
        
        if not temp_filename:
            print(f"Upload response missing 'filename' or 'version': {response_data}")
            return None
        if not temp_filename.startswith(lookup_filename.split('.')[0]):  # Check base filename
            print(f"Unexpected temporary filename '{temp_filename}' in response: {response_data}")
            return None
        
        return temp_filename
    except requests.exceptions.RequestException as e:
        print(f"Failed to upload '{lookup_filename}' to {worker_group}: {e}")
        return None


def create_lookup(token, organization_id, worker_group, lookup_filename, temp_filename):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/m/{worker_group}/system/lookups"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    payload = {
        "id": lookup_filename,
        "fileInfo": { "filename": temp_filename }
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        print(f"Created new lookup '{lookup_filename}' in {worker_group}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to create lookup '{lookup_filename}' in {worker_group}: {e}")
        return False


def update_lookup(token, organization_id, worker_group, lookup_filename, temp_filename):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/m/{worker_group}/system/lookups/{lookup_filename}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "accept": "application/json"
    }
    payload = {
        "id": lookup_filename,
        "fileInfo": {"filename": temp_filename}
    }
    
    try:
        response = requests.patch(url, headers=headers, json=payload)
        response.raise_for_status()
        print(f"Updated existing lookup '{lookup_filename}' in {worker_group}")
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to update lookup '{lookup_filename}' in {worker_group}: {e}")
        return False


def commit_changes(token, organization_id, worker_group, lookup_filename):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/m/{worker_group}/version/commit"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "message": "Automated lookup file update",
        "group": worker_group,
        "files": [
            f"groups/{worker_group}/data/lookups/{lookup_filename}",
            f"groups/{worker_group}/data/lookups/{Path(lookup_filename).with_suffix('.yml')}"
        ]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        response_data = response.json()

        commit_id = response_data["items"][0].get("commit")

        if not commit_id:
            print(f"Commit response missing 'commit' ID: {response.json()}")
            return None
        return commit_id
    except requests.exceptions.RequestException as e:
        print(f"Failed to commit changes for '{lookup_filename}' in {worker_group}: {e}")
        return None


def deploy_changes(token, organization_id, worker_group, commit_id):
    url = f"https://app.cribl.cloud/organizations/{organization_id}/workspaces/main/app/api/v1/master/groups/{worker_group}/deploy"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "accept": "application/json"
    }
    payload = {"version": commit_id}
    
    try:
        response = requests.patch(url, headers=headers, json=payload)
        response.raise_for_status()
        return True
    except requests.exceptions.RequestException as e:
        print(f"Failed to deploy changes to {worker_group}: {e}")
        return False


def main():
    try:
        # 1. Parse command-line arguments and load config
        args = parse_arguments()
        config = load_config(args.config)

        # 2. Override config with command-line args
        client_id = args.client_id or config["client_id"]
        client_secret = args.client_secret or config["client_secret"]
        organization_id = args.organization_id or config["organization_id"]
        lookup_filename = args.lookup_filename or config["lookup_filename"]
        target_worker_group = args.target_group or config["target_worker_group"]
        ad_server = args.ad_server or config["ad_server"]
        ad_user = args.ad_user or config["ad_user"]
        ad_password = args.ad_password or config["ad_password"]
        ad_domain = args.ad_domain or config["ad_domain"]
        ad_search_domain = args.ad_search_domain or config["ad_search_domain"]

        # 3. Query AD and generate CSV
        query_ad_users(ad_server, ad_user, ad_password, ad_domain, ad_search_domain, lookup_filename)
        
        # 4. Get the token
        token = get_bearer_token(client_id, client_secret)
        if not token:
            exit(1)
        print(f"Bearer token obtained: {token[:10]}...")

        # 5. Upload the file to the target worker group and get the temp filename
        temp_filename = upload_lookup_file(token, organization_id, target_worker_group, lookup_filename)
        if not temp_filename:
            exit(1)
        print(f"Uploaded '{lookup_filename}' to {target_worker_group}, temporary filename: '{temp_filename}'")

        # 6. Check for the file on the target worker group and create/update accordingly
        if check_lookup_exists(token, organization_id, target_worker_group, lookup_filename):
            print("Does exist on target.")
            if not update_lookup(token, organization_id, target_worker_group, lookup_filename, temp_filename):
                exit(1)
        else:
            print("Does not exist on target.")
            if not create_lookup(token, organization_id, target_worker_group, lookup_filename, temp_filename):
                exit(1)

        # 7. Commit the changes
        commit_id = commit_changes(token, organization_id, target_worker_group, lookup_filename)
        if not commit_id:
            exit(1)
        print(f"Changes committed with ID: {commit_id}")

        # 8. Deploy the changes
        if not deploy_changes(token, organization_id, target_worker_group, commit_id):
            exit(1)
        print(f"Successfully deployed changes to {target_worker_group}")

    except Exception as e:
        print(f"Error in main function: {e}")
        exit(1)


if __name__ == '__main__':
    main()