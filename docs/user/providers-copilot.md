# GitHub Copilot

T3 Code uses the GitHub Copilot CLI through the GitHub Copilot SDK. Install and authenticate the
Copilot CLI first, then enable the provider in Settings.

## Send follow-up messages

You can send a follow-up while Copilot is working to steer the current turn. The follow-up uses
the running turn’s model; model changes apply when a new turn starts.

## Enable experimental features

Open Settings → Providers → GitHub Copilot and turn on **Experimental features**. New Copilot
sessions will then be created with experimental mode enabled.

Experimental mode does not grant access to models that your Copilot account or organization does
not provide. If a model is not returned by the provider, add its model ID in the provider's Models
section as a custom model, then select it in a new thread.

## HydraFusion

With **Experimental features** enabled, select **HydraFusion (Research Preview)** in the model
picker. Use Copilot CLI 1.0.83 or newer. HydraFusion selects and combines underlying models, so
it does not offer a fixed reasoning effort or context window setting.

The preview is best suited to a substantial, well-scoped first prompt. If your CLI or account
cannot use HydraFusion, T3 reports the error rather than silently selecting another model.

## Configure the CLI

The default binary path is `copilot`. If T3 Code should use a different installation, set the
provider's **Binary path** in the same settings panel.

The GitHub Copilot CLI can also enable experimental mode with `copilot --experimental` or the
`/experimental on` command. The T3 Code setting applies the equivalent option directly to each new
SDK session.
