# GitHub Copilot

T3 Code uses the GitHub Copilot CLI through the GitHub Copilot SDK. Install and authenticate the
Copilot CLI first, then enable the provider in Settings.

## Enable experimental features

Open Settings → Providers → GitHub Copilot and turn on **Experimental features**. New Copilot
sessions will then be created with experimental mode enabled.

Experimental mode does not grant access to models that your Copilot account or organization does
not provide. If a model is not returned by the provider, add its model ID in the provider's Models
section as a custom model, then select it in a new thread.

## Configure the CLI

The default binary path is `copilot`. If T3 Code should use a different installation, set the
provider's **Binary path** in the same settings panel.

The GitHub Copilot CLI can also enable experimental mode with `copilot --experimental` or the
`/experimental on` command. The T3 Code setting applies the equivalent option directly to each new
SDK session.
