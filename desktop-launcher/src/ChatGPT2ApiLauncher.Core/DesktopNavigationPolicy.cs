namespace ChatGPT2ApiLauncher.Core;

public static class DesktopNavigationPolicy
{
    public static bool ShouldForceFullNavigation(
        Uri? committedUri,
        Uri changedUri,
        bool isNewDocument)
    {
        ArgumentNullException.ThrowIfNull(changedUri);
        if (isNewDocument || committedUri is null ||
            !committedUri.IsAbsoluteUri || !changedUri.IsAbsoluteUri)
        {
            return false;
        }

        if (!string.Equals(
                committedUri.GetLeftPart(UriPartial.Authority),
                changedUri.GetLeftPart(UriPartial.Authority),
                StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return !string.Equals(
            committedUri.PathAndQuery,
            changedUri.PathAndQuery,
            StringComparison.Ordinal);
    }
}
