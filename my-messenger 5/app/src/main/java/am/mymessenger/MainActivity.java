package am.mymessenger;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The window. The WebView itself belongs to Hub, so closing this window
 * does not stop the messenger. This activity only attaches the WebView to the screen.
 */
public class MainActivity extends Activity {

    private static final int REQ_MEDIA = 1;
    private static final int REQ_BASIC = 2;

    private PermissionRequest pendingRequest;
    private FrameLayout root;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Hub.activity = this;

        root = new FrameLayout(this);
        setContentView(root);
        showLastCrash();
        attachWeb();

        startService();
        askBasicPermissions();
        handleIntent(getIntent());
    }

    private void attachWeb() {
        WebView w = Hub.ensure(this);
        if (w.getParent() instanceof ViewGroup) {
            ((ViewGroup) w.getParent()).removeView(w);
        }
        root.addView(w, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    /** Opened from a notification: show the chat, and show over the lock screen for calls. */
    /** If the app crashed last time, show the error text so it can be reported. */
    private void showLastCrash() {
        try {
            java.io.File f = new java.io.File(getFilesDir(), "crash.txt");
            if (!f.exists()) return;
            byte[] b = new byte[(int) Math.min(f.length(), 6000)];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = in.read(b);
            in.close();
            f.delete();
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText(new String(b, 0, Math.max(n, 0), "UTF-8"));
            tv.setTextSize(11);
            tv.setTextIsSelectable(true);
            tv.setPadding(24, 24, 24, 24);
            android.widget.ScrollView sv = new android.widget.ScrollView(this);
            sv.addView(tv);
            new android.app.AlertDialog.Builder(this)
                    .setTitle("Նախորդ անգամ սխալ եղավ. արեք սքրինշոթ")
                    .setView(sv)
                    .setPositiveButton("OK", null)
                    .show();
        } catch (Exception ignored) {
            // the report is optional
        }
    }

    private void startService() {
        try {
            startForegroundService(new Intent(this, MessengerService.class));
        } catch (Exception e) {
            // The app still works while it is open.
        }
    }

    /** Opened from a notification: show the chat, and show over the lock screen for calls. */
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        if ("call".equals(intent.getAction())) {
            showOverLock(true);
        }
        String chat = intent.getStringExtra("chat");
        if (chat != null && !chat.isEmpty()) {
            Hub.pendingChat = chat;
            Hub.ensure(this).evaluateJavascript(
                    "window.__open && window.__open(" + JSONObject.quote(chat) + ")",
                    value -> { if ("true".equals(value)) Hub.pendingChat = null; });
        }
        intent.removeExtra("chat");
        intent.setAction(null);
    }

    @SuppressWarnings("deprecation")
    private void showOverLock(boolean on) {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(on);
            setTurnScreenOn(on);
        } else {
            int f = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
            if (on) {
                getWindow().addFlags(f);
            } else {
                getWindow().clearFlags(f);
            }
        }
    }

    /* ---------- permissions ---------- */

    private void askBasicPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (need.isEmpty()) {
            askBatteryOnce();
        } else {
            requestPermissions(need.toArray(new String[0]), REQ_BASIC);
        }
    }

    private void askBatteryOnce() {
        SharedPreferences sp = getSharedPreferences("app", MODE_PRIVATE);
        if (sp.getBoolean("battery_asked", false)) return;
        sp.edit().putBoolean("battery_asked", true).apply();
        new NativeBridge(getApplicationContext()).openSettings("battery");
    }

    /** Called when the page asks for camera or microphone. */
    void handlePermissionRequest(PermissionRequest request) {
        List<String> missing = new ArrayList<>();
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.CAMERA);
            } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                missing.add(Manifest.permission.RECORD_AUDIO);
            }
        }
        if (missing.isEmpty()) {
            request.grant(request.getResources());
            return;
        }
        if (pendingRequest != null) {
            pendingRequest.deny();
        }
        pendingRequest = request;
        requestPermissions(missing.toArray(new String[0]), REQ_MEDIA);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BASIC) {
            askBatteryOnce();
            return;
        }
        if (requestCode != REQ_MEDIA || pendingRequest == null) {
            return;
        }
        boolean all = grantResults.length > 0;
        for (int g : grantResults) {
            if (g != PackageManager.PERMISSION_GRANTED) {
                all = false;
            }
        }
        if (all) {
            pendingRequest.grant(pendingRequest.getResources());
        } else {
            pendingRequest.deny();
        }
        pendingRequest = null;
    }

    /* ---------- lifecycle ---------- */

    @Override
    protected void onStart() {
        super.onStart();
        Hub.visible = true;
    }

    @Override
    protected void onStop() {
        Hub.visible = false;
        showOverLock(false);
        super.onStop();
    }

    @Override
    public void onBackPressed() {
        Hub.ensure(this).evaluateJavascript(
                "window.__back ? window.__back() : false", value -> {
                    if (!"true".equals(value)) {
                        // Hide the window but keep the messenger running.
                        moveTaskToBack(true);
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (pendingRequest != null) {
            pendingRequest.deny();
            pendingRequest = null;
        }
        if (root != null) {
            root.removeAllViews(); // the WebView stays alive in Hub
        }
        if (Hub.activity == this) {
            Hub.activity = null;
        }
        super.onDestroy();
    }
}
