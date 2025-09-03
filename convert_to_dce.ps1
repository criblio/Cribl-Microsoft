# PowerShell Script to Convert NoDCE DCR Templates to DCE Templates
# This script copies files from NoDCE directory to DCE directory and modifies them

# Set the base paths
$noDCEPath = "C:\Users\James Pederson\Desktop\git\Remote\Cribl-Microsoft\Azure\CustomDeploymentTemplates\DataCollectionRules\SentinelNativeTables\DataCollectionRules(NoDCE)"
$dcePath = "C:\Users\James Pederson\Desktop\git\Remote\Cribl-Microsoft\Azure\CustomDeploymentTemplates\DataCollectionRules\SentinelNativeTables\DataCollectionRules(DCE)"

# Get all JSON files from NoDCE directory
$noDCEFiles = Get-ChildItem -Path $noDCEPath -Filter "*.json"

Write-Host "Found $($noDCEFiles.Count) files to convert from NoDCE to DCE format" -ForegroundColor Green
Write-Host ""

foreach ($file in $noDCEFiles) {
    try {
        # Skip if the file already exists in DCE format (like CommonSecurityLog)
        $dceFileName = $file.Name -replace "-NoDCE\.json$", "-DCE.json"
        $dceFilePath = Join-Path -Path $dcePath -ChildPath $dceFileName
        
        if (Test-Path $dceFilePath) {
            Write-Host "Skipping $($file.Name) - DCE version already exists" -ForegroundColor Yellow
            continue
        }
        
        Write-Host "Processing: $($file.Name)" -ForegroundColor Cyan
        
        # Read the original file content
        $content = Get-Content -Path $file.FullName -Raw
        
        # Parse JSON
        $jsonObject = $content | ConvertFrom-Json -Depth 100
        
        # Add the endpointResourceId parameter
        $endpointParameter = @{
            type = "string"
            metadata = @{
                description = "Specifies the Azure resource ID of the Data Collection Endpoint to use."
            }
        }
        
        $jsonObject.parameters | Add-Member -MemberType NoteProperty -Name "endpointResourceId" -Value $endpointParameter
        
        # Modify the resource properties
        $resource = $jsonObject.resources[0]
        
        # Remove the "kind" property if it exists
        if ($resource.PSObject.Properties.Name -contains "kind") {
            $resource.PSObject.Properties.Remove("kind")
        }
        
        # Add the dataCollectionEndpointId property to the resource properties
        $resource.properties | Add-Member -MemberType NoteProperty -Name "dataCollectionEndpointId" -Value "[parameters('endpointResourceId')]"
        
        # Convert back to JSON with proper formatting
        $modifiedJson = $jsonObject | ConvertTo-Json -Depth 100 -Compress:$false
        
        # Write to the DCE directory with the new filename
        $modifiedJson | Out-File -FilePath $dceFilePath -Encoding UTF8 -NoNewline
        
        Write-Host "  ✓ Successfully created: $dceFileName" -ForegroundColor Green
        
    }
    catch {
        Write-Host "  ✗ Error processing $($file.Name): $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ""
Write-Host "Conversion completed!" -ForegroundColor Green
Write-Host ""

# Display summary
$dceFiles = Get-ChildItem -Path $dcePath -Filter "*.json"
Write-Host "DCE Directory now contains $($dceFiles.Count) files:" -ForegroundColor Yellow
$dceFiles.Name | Sort-Object | ForEach-Object { Write-Host "  - $_" -ForegroundColor White }