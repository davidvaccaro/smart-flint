# Docker Desktop with Linux containers is the only host runtime requirement.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$InstallerArguments)
$ErrorActionPreference = 'Stop'
$SourceDirectory = $PSScriptRoot
$Directory = Join-Path $HOME '.smart-flint'
$ConfigFile = $null; $ImageArchive = $null; $Checksums = $null; $NoOpen = $false
$Forward = [System.Collections.Generic.List[string]]::new()
for ($Index = 0; $Index -lt $InstallerArguments.Count; $Index++) {
    $Value = $InstallerArguments[$Index]
    $Parts = $Value.Split('=', 2)
    if ($Parts[0] -in @('--directory','--config','--image-archive','--checksums')) {
        if ($Parts.Count -eq 2) { $PathValue = $Parts[1] }
        else { $Index++; if ($Index -ge $InstallerArguments.Count) { throw "Missing installer path option value." }; $PathValue = $InstallerArguments[$Index] }
        switch ($Parts[0]) { '--directory' {$Directory=$PathValue}; '--config' {$ConfigFile=$PathValue}; '--image-archive' {$ImageArchive=$PathValue}; '--checksums' {$Checksums=$PathValue} }
    } elseif ($Value -eq '--help') {
        Write-Output 'SMART Flint Docker-only installer: .\install.ps1 [--mode sandbox|deploy] [--directory PATH] [--port N] [--public-url https://HOST] [--tls external|caddy] [--auth local|oidc] [--config PRIVATE_JSON] [--image REFERENCE | --image-archive FILE] [--configure-only] [--non-interactive] [--no-open] [--action start|status|stop]'
        exit 0
    } else { if ($Value -eq '--no-open') {$NoOpen=$true}; $Forward.Add($Value) }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers, then run this installer again.' }
& docker version --format '{{.Server.Version}}' *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is unavailable. Start Docker Desktop.' }
if ((& docker info --format '{{.OSType}}') -ne 'linux') { throw 'Switch Docker Desktop to Linux containers.' }
$Directory = [System.IO.Path]::GetFullPath($Directory)
if (Test-Path -LiteralPath $Directory) {
    $Item = Get-Item -LiteralPath $Directory -Force
    if (-not $Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use a private directory without reparse points.' }
    if (-not (Test-Path -LiteralPath (Join-Path $Directory 'installation.json')) -and (Get-ChildItem -LiteralPath $Directory -Force | Select-Object -First 1)) { throw 'Choose a new empty installation directory.' }
} else { [IO.Directory]::CreateDirectory($Directory) | Out-Null }
if ($Directory.StartsWith($SourceDirectory+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $Directory -eq $SourceDirectory) { throw 'Choose an installation folder outside the source checkout.' }
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function AssertPrivateFile([string]$Path) {
    $FileAcl=Get-Acl -LiteralPath $Path
    if ($FileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $Sid.Value) { throw 'Private installation/configuration files must be owned by your account.' }
    foreach ($Access in $FileAcl.Access) {
        if ($Access.AccessControlType -ne 'Allow') { continue }
        $Identity=$Access.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($Identity -notin @($Sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Restrict private file access to your account, SYSTEM and Administrators before continuing.' }
    }
}
$Acl = [Security.AccessControl.DirectorySecurity]::new()
$Acl.SetOwner($Sid); $Acl.SetAccessRuleProtection($true,$false)
$Rule = [Security.AccessControl.FileSystemAccessRule]::new($Sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$Acl.AddAccessRule($Rule); Set-Acl -LiteralPath $Directory -AclObject $Acl
foreach ($Managed in @('installation.json','compose.yaml','setup-secrets.json','image.lock.yaml','Caddyfile','installation.md')) {
    $ManagedPath=Join-Path $Directory $Managed
    if (Test-Path -LiteralPath $ManagedPath) { AssertPrivateFile $ManagedPath }
}
if (($SourceDirectory+$Directory).Contains(',')) { throw 'Installation/source paths must not contain commas.' }
$Temporary = Join-Path ([IO.Path]::GetTempPath()) ('smart-flint-installer-'+[Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Temporary) | Out-Null
$Mounts = @('--mount',"type=bind,source=$SourceDirectory,target=/source,readonly",'--mount',"type=bind,source=$Directory,target=/installation",'-v','/var/run/docker.sock:/var/run/docker.sock')
function RegularInput([string]$Path) {
    $Item = Get-Item -LiteralPath $Path -Force
    if ($Item.PSIsContainer -or ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Use regular installer input files without reparse points.' }
    if ($Item.FullName.Contains(',')) { throw 'Input paths must not contain commas.' }
    return $Item.FullName
}
$PreviousBuildx = $env:BUILDX_CONFIG
try {
    if ($ConfigFile) { $ConfigFile=RegularInput $ConfigFile; AssertPrivateFile $ConfigFile; $Mounts+=@('--mount',"type=bind,source=$ConfigFile,target=/input/config.json,readonly"); $Forward.Add('--config'); $Forward.Add('/input/config.json') }
    if ($ImageArchive) {
        $ImageArchive=RegularInput $ImageArchive
        if (-not $Checksums) { $Checksums=Join-Path (Split-Path $ImageArchive -Parent) 'SHA256SUMS' }
        $Checksums=RegularInput $Checksums; $Name=Split-Path $ImageArchive -Leaf
        $Mounts+=@('--mount',"type=bind,source=$ImageArchive,target=/artifact/$Name,readonly",'--mount',"type=bind,source=$Checksums,target=/artifact/SHA256SUMS,readonly")
        $Forward.Add('--image-archive'); $Forward.Add("/artifact/$Name"); $Forward.Add('--checksums'); $Forward.Add('/artifact/SHA256SUMS')
    } elseif ($Checksums) { throw '--checksums requires --image-archive.' }
    if (-not $env:BUILDX_CONFIG) { $env:BUILDX_CONFIG=Join-Path $Temporary 'buildx' }
    Write-Output 'Preparing the Docker-only SMART Flint installer...'
    & docker build --quiet --file (Join-Path $SourceDirectory 'deploy/Dockerfile.installer') --iidfile (Join-Path $Temporary 'image.id') $SourceDirectory | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The installer image could not be built. Check Docker Desktop and internet access.' }
    $Image=(Get-Content -LiteralPath (Join-Path $Temporary 'image.id') -Raw).Trim()
    $Run=@('run','--rm','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=256m','--cap-drop','ALL','--security-opt','no-new-privileges')
    if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { $Run+='-it' } else { $Run+='-i' }
    $Run+=$Mounts
    $Run+=@('-e','HOME=/tmp','-e','DOCKER_CONFIG=/tmp/docker','-e','BUILDX_CONFIG=/tmp/buildx','-e','SMART_FLINT_SOURCE_DIRECTORY=/source','-e','SMART_FLINT_INSTALL_DIRECTORY=/installation','-e',"SMART_FLINT_HOST_DIRECTORY=$Directory",'-e',"SMART_FLINT_INSTALLER_IMAGE=$Image",'-e','SMART_FLINT_HOST_PLATFORM=windows','-e','SMART_FLINT_WINDOWS_PRIVATE=1')
    $Result=Join-Path $Directory '.browser-result.json'
    if (-not $NoOpen) { if (Test-Path -LiteralPath $Result) { RegularInput $Result | Out-Null; Remove-Item -LiteralPath $Result }; $Run+=@('-e','SMART_FLINT_BROWSER_RESULT=/installation/.browser-result.json') }
    & docker @Run $Image --directory /installation @Forward
    if ($LASTEXITCODE -ne 0) { throw 'SMART Flint setup did not finish. Existing configuration and data were retained.' }
    if (-not $NoOpen -and (Test-Path -LiteralPath $Result)) {
        $Url=(Get-Content -LiteralPath $Result -Raw | ConvertFrom-Json).url
        Remove-Item -LiteralPath $Result
        if ($Url -match '^https://' -or $Url -match '^http://127\.0\.0\.1:[0-9]+$') { Start-Process -FilePath $Url }
    }
} finally {
    $env:BUILDX_CONFIG=$PreviousBuildx
    Remove-Item -LiteralPath $Temporary -Recurse -Force -ErrorAction SilentlyContinue
}
