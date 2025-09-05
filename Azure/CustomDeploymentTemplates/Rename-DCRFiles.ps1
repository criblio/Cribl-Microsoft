# Script to rename DCR template files by removing prefixes and suffixes
# This will rename files from "dcr-TableName-DCE.json" to "TableName.json"

$directories = @(
    "C:\Users\James Pederson\Desktop\git\Remote\Cribl-Microsoft\Azure\CustomDeploymentTemplates\DataCollectionRules\SentinelNativeTables\DataCollectionRules(NoDCE)",
    "C:\Users\James Pederson\Desktop\git\Remote\Cribl-Microsoft\Azure\CustomDeploymentTemplates\DataCollectionRules\SentinelNativeTables\DataCollectionRules(DCE)"
)

$renameCount = 0

foreach ($directory in $directories) {
    Write-Host "Processing directory: $directory" -ForegroundColor Yellow
    
    if (Test-Path $directory) {
        $files = Get-ChildItem -Path $directory -Filter "dcr-*.json"
        
        foreach ($file in $files) {
            $oldName = $file.Name
            
            # Remove "dcr-" prefix and "-DCE" or "-NoDCE" suffix
            $newName = $oldName -replace '^dcr-', ''  # Remove dcr- prefix
            $newName = $newName -replace '-DCE\.json$', '.json'  # Remove -DCE suffix
            $newName = $newName -replace '-NoDCE\.json$', '.json'  # Remove -NoDCE suffix
            
            if ($oldName -ne $newName) {
                $oldPath = $file.FullName
                $newPath = Join-Path $directory $newName
                
                try {
                    Rename-Item -Path $oldPath -NewName $newName -ErrorAction Stop
                    Write-Host "  ✅ Renamed: $oldName → $newName" -ForegroundColor Green
                    $renameCount++
                } catch {
                    Write-Host "  ❌ Failed to rename $oldName: $($_.Exception.Message)" -ForegroundColor Red
                }
            } else {
                Write-Host "  ℹ️  No change needed: $oldName" -ForegroundColor Gray
            }
        }
    } else {
        Write-Host "  ❌ Directory not found: $directory" -ForegroundColor Red
    }
}

Write-Host "`nRename operation completed!" -ForegroundColor Cyan
Write-Host "Total files renamed: $renameCount" -ForegroundColor Green