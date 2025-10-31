# DNS A Records Reference for Private Link

This document provides the exact A records needed for Active Directory DNS configuration using the Direct A Records approach (without conditional forwarders).

## Overview

Your Private Endpoint (`pep-la-jpederson-eastus`) has **21 private IP addresses** mapped to different Azure Monitor services and DCE endpoints.

---

## Required DNS Forward Lookup Zones

Create these zones in Active Directory DNS:

```
opinsights.azure.com
azure-automation.net
monitor.azure.com
core.windows.net
```

---

## A Records to Create

### Zone: opinsights.azure.com

| Host Name | IP Address | Purpose |
|-----------|------------|---------|
| `4512205b-0417-49aa-a2fb-c74ccd652787.oms` | 10.198.30.69 | Log Analytics workspace queries |
| `4512205b-0417-49aa-a2fb-c74ccd652787.ods` | 10.198.30.70 | Log Analytics data ingestion |

### Zone: azure-automation.net

| Host Name | IP Address | Purpose |
|-----------|------------|---------|
| `4512205b-0417-49aa-a2fb-c74ccd652787.agentsvc` | 10.198.30.71 | Azure Automation (optional) |

### Zone: monitor.azure.com

**Critical for Cribl Ingestion:**

| Host Name | IP Address | Purpose | Cribl Usage |
|-----------|------------|---------|-------------|
| `dce-jp-commonsecuritylog-eastus-udpx.eastus-1.handler.control` | 10.198.30.72 | DCE control endpoint | Not used |
| `dce-jp-commonsecuritylog-eastus-udpx.eastus-1.ingest` | 10.198.30.73 | **DCE ingestion endpoint** | **REQUIRED** |
| `dce-jp-commonsecuritylog-eastus-udpx.eastus-1.metrics.ingest` | 10.198.30.74 | DCE metrics | Not used |
| `dce-jp-securityevent-eastus-oj6f.eastus-1.handler.control` | 10.198.30.75 | DCE control endpoint | Not used |
| `dce-jp-securityevent-eastus-oj6f.eastus-1.ingest` | 10.198.30.76 | **DCE ingestion endpoint** | **REQUIRED** |
| `dce-jp-securityevent-eastus-oj6f.eastus-1.metrics.ingest` | 10.198.30.77 | DCE metrics | Not used |
| `dce-jp-windowsevent-eastus-efse.eastus-1.handler.control` | 10.198.30.78 | DCE control endpoint | Not used |
| `dce-jp-windowsevent-eastus-efse.eastus-1.ingest` | 10.198.30.79 | **DCE ingestion endpoint** | **REQUIRED** |
| `dce-jp-windowsevent-eastus-efse.eastus-1.metrics.ingest` | 10.198.30.80 | DCE metrics | Not used |
| `dce-jp-syslog-eastus-6pfd.eastus-1.handler.control` | 10.198.30.81 | DCE control endpoint | Not used |
| `dce-jp-syslog-eastus-6pfd.eastus-1.ingest` | 10.198.30.82 | **DCE ingestion endpoint** | **REQUIRED** |
| `dce-jp-syslog-eastus-6pfd.eastus-1.metrics.ingest` | 10.198.30.83 | DCE metrics | Not used |
| `api` | 10.198.30.84 | Azure Monitor API | Not used by Cribl |
| `global.in.ai` | 10.198.30.85 | Application Insights | Not used by Cribl |
| `profiler` | 10.198.30.86 | Profiler service | Not used by Cribl |
| `live` | 10.198.30.87 | Live metrics | Not used by Cribl |
| `diagservices-query` | 10.198.30.88 | Diagnostic services | Not used by Cribl |
| `snapshot` | 10.198.30.89 | Snapshot debugger | Not used by Cribl |
| `global.handler.control` | 10.198.30.91 | Global control endpoint | May be used |

### Zone: core.windows.net

| Host Name | IP Address | Purpose |
|-----------|------------|---------|
| `scadvisorcontentpl.blob` | 10.198.30.90 | Storage account (optional) |

---

## Minimal Configuration for Cribl Only

If you only need Cribl DCE ingestion to work, create these **4 critical A records**:

### Zone: monitor.azure.com

```
Host: dce-jp-commonsecuritylog-eastus-udpx.eastus-1.ingest
IP: 10.198.30.73

Host: dce-jp-securityevent-eastus-oj6f.eastus-1.ingest
IP: 10.198.30.76

Host: dce-jp-windowsevent-eastus-efse.eastus-1.ingest
IP: 10.198.30.79

Host: dce-jp-syslog-eastus-6pfd.eastus-1.ingest
IP: 10.198.30.82
```

**Optional (recommended for completeness):**
- Add the 3 workspace records in `opinsights.azure.com` zone
- Add `global.handler.control.monitor.azure.com` (IP: 10.198.30.91)

---

## PowerShell Script for Automated Creation

```powershell
# Run this on your Active Directory DNS Server
# Requires: DNS Server role, Administrator privileges

# Define your AD DNS server
$dnsServer = $env:COMPUTERNAME

# Create DNS zones if they don't exist
$zones = @(
 "opinsights.azure.com",
 "azure-automation.net",
 "monitor.azure.com",
 "core.windows.net"
)

foreach ($zone in $zones) {
 $existing = Get-DnsServerZone -Name $zone -ErrorAction SilentlyContinue
 if (-not $existing) {
 Add-DnsServerPrimaryZone -Name $zone -ReplicationScope "Domain" -DynamicUpdate Secure
 Write-Host "Created zone: $zone" -ForegroundColor Green
 } else {
 Write-Host "Zone already exists: $zone" -ForegroundColor Yellow
 }
}

# Define all A records
$records = @(
 # Log Analytics Workspace
 @{ Zone = "opinsights.azure.com"; Name = "4512205b-0417-49aa-a2fb-c74ccd652787.oms"; IP = "10.198.30.69" },
 @{ Zone = "opinsights.azure.com"; Name = "4512205b-0417-49aa-a2fb-c74ccd652787.ods"; IP = "10.198.30.70" },
 @{ Zone = "azure-automation.net"; Name = "4512205b-0417-49aa-a2fb-c74ccd652787.agentsvc"; IP = "10.198.30.71" },

 # DCE: CommonSecurityLog
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-commonsecuritylog-eastus-udpx.eastus-1.handler.control"; IP = "10.198.30.72" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-commonsecuritylog-eastus-udpx.eastus-1.ingest"; IP = "10.198.30.73" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-commonsecuritylog-eastus-udpx.eastus-1.metrics.ingest"; IP = "10.198.30.74" },

 # DCE: SecurityEvent
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-securityevent-eastus-oj6f.eastus-1.handler.control"; IP = "10.198.30.75" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-securityevent-eastus-oj6f.eastus-1.ingest"; IP = "10.198.30.76" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-securityevent-eastus-oj6f.eastus-1.metrics.ingest"; IP = "10.198.30.77" },

 # DCE: WindowsEvent
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-windowsevent-eastus-efse.eastus-1.handler.control"; IP = "10.198.30.78" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-windowsevent-eastus-efse.eastus-1.ingest"; IP = "10.198.30.79" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-windowsevent-eastus-efse.eastus-1.metrics.ingest"; IP = "10.198.30.80" },

 # DCE: Syslog
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-syslog-eastus-6pfd.eastus-1.handler.control"; IP = "10.198.30.81" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-syslog-eastus-6pfd.eastus-1.ingest"; IP = "10.198.30.82" },
 @{ Zone = "monitor.azure.com"; Name = "dce-jp-syslog-eastus-6pfd.eastus-1.metrics.ingest"; IP = "10.198.30.83" },

 # Azure Monitor Services
 @{ Zone = "monitor.azure.com"; Name = "api"; IP = "10.198.30.84" },
 @{ Zone = "monitor.azure.com"; Name = "global.in.ai"; IP = "10.198.30.85" },
 @{ Zone = "monitor.azure.com"; Name = "profiler"; IP = "10.198.30.86" },
 @{ Zone = "monitor.azure.com"; Name = "live"; IP = "10.198.30.87" },
 @{ Zone = "monitor.azure.com"; Name = "diagservices-query"; IP = "10.198.30.88" },
 @{ Zone = "monitor.azure.com"; Name = "snapshot"; IP = "10.198.30.89" },
 @{ Zone = "monitor.azure.com"; Name = "global.handler.control"; IP = "10.198.30.91" },

 # Storage Account
 @{ Zone = "core.windows.net"; Name = "scadvisorcontentpl.blob"; IP = "10.198.30.90" }
)

# Create A records
foreach ($record in $records) {
 $existing = Get-DnsServerResourceRecord -ZoneName $record.Zone -Name $record.Name -RRType A -ErrorAction SilentlyContinue

 if (-not $existing) {
 Add-DnsServerResourceRecordA -ZoneName $record.Zone -Name $record.Name -IPv4Address $record.IP
 Write-Host "Created A record: $($record.Name).$($record.Zone) -> $($record.IP)" -ForegroundColor Green
 } else {
 Write-Host "A record already exists: $($record.Name).$($record.Zone)" -ForegroundColor Yellow
 }
}

Write-Host "`n DNS configuration complete!" -ForegroundColor Green
Write-Host "Total zones: $($zones.Count)" -ForegroundColor Cyan
Write-Host "Total A records: $($records.Count)" -ForegroundColor Cyan
```

---

## Testing DNS Resolution

From your Cribl worker nodes, test DNS resolution:

```bash
# Test DCE ingestion endpoints (critical for Cribl)
nslookup dce-jp-commonsecuritylog-eastus-udpx.eastus-1.ingest.monitor.azure.com
nslookup dce-jp-securityevent-eastus-oj6f.eastus-1.ingest.monitor.azure.com
nslookup dce-jp-windowsevent-eastus-efse.eastus-1.ingest.monitor.azure.com
nslookup dce-jp-syslog-eastus-6pfd.eastus-1.ingest.monitor.azure.com

# Expected result: Should resolve to 10.198.30.73, 10.198.30.76, 10.198.30.79, 10.198.30.82
```

---

## Troubleshooting

### DNS not resolving to private IPs

1. **Verify DNS zones exist**: `Get-DnsServerZone` on AD DNS server
2. **Verify A records exist**: `Get-DnsServerResourceRecord -ZoneName "monitor.azure.com" -RRType A`
3. **Check DNS server order** on Cribl worker: AD DNS should be primary
4. **Flush DNS cache** on Cribl worker: `ipconfig /flushdns` (Windows) or `sudo systemd-resolve --flush-caches` (Linux)
5. **Test from DNS server directly**: Rule out replication issues

### Still resolving to public IPs

- Check if other DNS servers (e.g., 8.8.8.8) are configured on the Cribl worker
- Verify VPN/ExpressRoute connectivity between on-premises and Azure VNet
- Ensure the Private Endpoint subnet has proper NSG rules allowing traffic

---

## Summary

For **Cribl DCE ingestion with Private Link**, you need:

 **4 critical A records** (DCE `.ingest` endpoints)
 **3 workspace A records** (optional but recommended)
 **1 global control record** (optional but recommended)

**Total minimal records: 8 A records across 2 DNS zones**

For **full Azure Monitor Private Link support**, configure all 21 records.
