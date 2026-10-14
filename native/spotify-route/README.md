# Spotify route component source

This is the source used for the bundled Windows x64 route host, including the inactive cross-process session classification and journal-based orphan route recovery fixes. It contains no user configuration, route journals, Spotify assets, or backups.

Build with the .NET 8 SDK on Windows:

```powershell
dotnet publish OwnedRoute.ProductHost/OwnedRoute.ProductHost.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o publish
dotnet run --project OwnedRoute.Observation.Tests/OwnedRoute.Observation.Tests.csproj -c Release
dotnet run --project OwnedRoute.ProductWindows.Tests/OwnedRoute.ProductWindows.Tests.csproj -c Release
```

Packaging renames `folia-route-product-host.exe` to `folia-route-service.exe` and records the resulting binary in the component manifest. The binary must match the route entry in `electron/spotify/componentBundle.json`.

`--recover-orphan-route` only restores a retained Folia journal for the same verified Spotify application when its previous process has exited and the current audio session is paused. It appends to the original journal; it does not guess original endpoints or change Windows global default outputs.
