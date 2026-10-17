package app.quickvote.android;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Must match "server.errorPath" in capacitor.config.json.
    private static final String OFFLINE_PAGE = "/offline.html";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Capacitor core does not map the hardware back button to WebView history
        // (that lives in the optional @capacitor/app plugin), so do it here.
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                    String url = webView != null ? webView.getUrl() : null;
                    // On the offline page, going back would reload the failed page and bounce
                    // straight back here, so let back leave the app instead.
                    boolean onOfflinePage = url != null && url.endsWith(OFFLINE_PAGE);
                    if (webView != null && webView.canGoBack() && !onOfflinePage) {
                        webView.goBack();
                    } else {
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                    }
                }
            }
        );
    }
}
