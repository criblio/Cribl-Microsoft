# Cribl-Microsoft PowerBI Integration

Connect PowerBI to Cribl Search API for querying and visualizing data from Cribl Lake using OAuth2 Client Credentials authentication.

> **💡 Important**: This integration uses **Get Data > Blank Query**, NOT Get Data > Web. The Web connector cannot handle Client Credentials authentication.

## 📁 Repository Contents

| File | Description |
|------|-------------|
| `QUICK_START.md` | Complete setup guide with step-by-step instructions |
| `CONNECTION_METHOD.md` | Visual guide explaining why to use Blank Query, not Web |
| `CriblSearchQuery.pq` | Sample Power Query M script with authentication |
| `Test-CriblConnection.ps1` | PowerShell script to test credentials (optional) |
| `README.md` | This file - overview and quick links |

## 🚀 Getting Started

1. **Get your Cribl API Credentials**: 
   - Log into Cribl → Organization → API Credentials
   - Create new credentials with Search permissions
   - Save your Client ID and Client Secret

2. **Open PowerBI Desktop**:
   - Click **Get Data**
   - Search for **"Blank Query"** (⚠️ NOT "Web"!)
   - Click **Connect**

3. **Configure the Query**:
   - Right-click "Query1" → **Advanced Editor**
   - Paste code from `CriblSearchQuery.pq`
   - Update Client ID, Secret, and instance
   - Click **Done**

4. **Start visualizing**: Data loads automatically!

## 🔐 Authentication Flow

This integration uses OAuth2 Client Credentials flow:
1. PowerBI exchanges Client ID/Secret for a bearer token
2. Bearer token is used for all API calls
3. Token automatically obtained within Power Query

## 🔧 Quick Setup

### Required Information
- Cribl Instance URL (e.g., `your-instance.cribl.cloud`)
- Client ID (from API Credentials)
- Client Secret (from API Credentials)
- Dataset ID from Cribl Lake

### PowerBI Desktop Steps
1. **Get Data** (from Home ribbon)
2. Search for **"Blank Query"** (NOT "Web"!)
3. Click **Connect**
4. Right-click "Query1" → **Advanced Editor**
5. Paste query from `CriblSearchQuery.pq`
6. Update configuration values
7. Click **Done** then **Close & Apply**

## ❌ Common Mistake to Avoid

**DO NOT** use Get Data > Web - it cannot handle the OAuth2 authentication flow required by Cribl. You must use **Get Data > Blank Query**.

## 📊 Use Cases

- **Security Analytics**: Visualize security events from Cribl Lake
- **Log Analysis**: Create dashboards for application and infrastructure logs
- **Metrics Monitoring**: Build real-time metrics dashboards
- **Compliance Reporting**: Generate compliance reports from archived data
- **Cost Analysis**: Track and visualize data ingestion and processing costs

## 🔗 Important Links

- [Cribl Search Documentation](https://docs.cribl.io/stream/search/)
- [Cribl API Reference](https://docs.cribl.io/api/)
- [Power Query M Reference](https://docs.microsoft.com/en-us/powerquery-m/)

## ⚡ Performance Tips

1. **Limit initial queries**: Start with small time ranges and limits
2. **Use Cribl Search optimizations**: Apply filters early in your search query
3. **Cache results**: Configure appropriate refresh schedules in PowerBI
4. **Monitor job execution**: Check Cribl UI for query performance

## 🛠️ Troubleshooting

Common issues:
- **Authentication errors**: Verify Client ID/Secret are correct
- **"Web.Contents failed"**: Make sure you're using Blank Query, not Web connector
- **Timeout issues**: Reduce query complexity or time range
- **Missing data**: Check dataset availability in Cribl Lake

See [QUICK_START.md](./QUICK_START.md#troubleshooting) for detailed troubleshooting steps.

## 📝 License

This integration guide is provided as-is for Cribl and PowerBI users.

## 🤝 Contributing

To contribute improvements:
1. Test your changes thoroughly
2. Update documentation
3. Include example queries where applicable

---

*For detailed instructions, see [QUICK_START.md](./QUICK_START.md)*