import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { defaultAppConfig, type AppConfig, type AppConfigPatch } from "@shared/ipc";
import { Switch } from "./components";

/**
 * 常规设置面板(应用级:系统托盘、主窗关闭按钮)。
 *
 * 与外部 API 面板同构:自带加载态,不受 App.tsx 那层歌词配置封锁的影响;
 * 也同样不做防抖 —— 这里每一项都是一次性的开关/下拉,没有边打字边提交的场景。
 */
export default function GeneralPanel(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig>(defaultAppConfig);
  const [loaded, setLoaded] = useState(false);
  const loadedRef = useRef(false);

  const patchConfig = useCallback((patch: AppConfigPatch) => {
    if (!loadedRef.current) return;
    setConfig((prev) => ({ ...prev, ...patch }));
    window.desktopAPI.setAppConfig(patch);
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const current = await window.desktopAPI.getAppConfig();
        if (!disposed && current) setConfig((prev) => ({ ...prev, ...current }));
      } catch (error) {
        console.error("Failed to load app config:", error);
      }
      loadedRef.current = true;
      if (!disposed) setLoaded(true);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // 配置回声:本窗提交后 main 合并出的完整配置,以及关闭确认框里
  // 勾了「记住我的选择」时 main 自行写回的那次变更
  useEffect(() => {
    return window.desktopAPI.onAppConfigChanged((next) => {
      if (next) setConfig((prev) => ({ ...prev, ...next }));
    });
  }, []);

  return (
    <div style={loaded ? undefined : { pointerEvents: "none", opacity: 0.5 }}>
      <section className="settings-section">
        <h3>系统托盘</h3>

        <div className="setting-item flex-row">
          <label>
            显示播放进度
            <span className="setting-sub">
              托盘图标底部显示进度条，悬浮查看播放时间；macOS 菜单栏同时显示「已播放 / 总时长」
            </span>
          </label>
          <Switch
            checked={config.trayProgress}
            onChange={(value) => patchConfig({ trayProgress: value })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h3>主窗口关闭按钮</h3>

        <div className="setting-item">
          <label>点击关闭时</label>
          <select
            className="select-input"
            value={config.closeAction}
            onChange={(e) =>
              patchConfig({ closeAction: e.target.value as AppConfig["closeAction"] })
            }
          >
            <option value="minimize">最小化到托盘（后台继续播放）</option>
            <option value="quit">直接退出程序</option>
          </select>
        </div>

        <div className="setting-item flex-row">
          <label>
            关闭前二次确认
            <span className="setting-sub">
              弹窗让你当场选「最小化到托盘 / 退出程序」，可勾选记住选择
            </span>
          </label>
          <Switch
            checked={config.closeConfirm}
            onChange={(value) => patchConfig({ closeConfirm: value })}
          />
        </div>

        <p className="setting-note">
          该设置同时作用于界面上的关闭按钮与系统快捷键（⌘W / Alt+F4）。托盘菜单里的「退出」不受影响，始终直接退出。
        </p>
      </section>
    </div>
  );
}
