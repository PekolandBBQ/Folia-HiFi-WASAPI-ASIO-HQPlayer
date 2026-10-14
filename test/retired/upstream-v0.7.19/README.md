# Library account test migration

The upstream v0.7.19 account controller replaces useOnlineProviderPlatform. Its transaction tests are retained here as historical evidence; current selection, confirmation, cleanup, refreshed login, cancellation and stale completion are tested against providerAccountController. Spotify guide completion is tested separately against its current adapter.

The obsolete Soloist key/receiver component spec is retained as spotifyAccount-Soloist.spec.ts.txt. Current Wrapper installation, configuration, saved setup, Store detection, restart guidance and library completion run in spotifyWrapperGuide.spec.ts. Public synthetic fixtures do not stand in for real installation or playback acceptance.
