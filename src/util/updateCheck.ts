import { loggerState } from './logger';

export const UPDATE_CHECK_ENV = 'QQ_DISABLE_UPDATE_CHECK';
export const UPDATE_CHECK_OPT_IN_ENV = 'QQ_ENABLE_UPDATE_CHECK';

// 当前文件：决定启动时是否向 npm registry 查询最新版本。
// 默认关闭，只有显式开启才检查：本包会被当作依赖 `require()` 进宿主进程（Docker / Electron），
// 在 import 期 spawn `npm` 是不受欢迎的副作用 —— 容器里是一次没有意义的外连，
// Windows 打包应用还可能闪出控制台窗口。
// `QQ_DISABLE_UPDATE_CHECK=true` 继续有效（优先级最高），保持既有部署配置不失效。
export const shouldCheckLatestVersion = (): boolean => {
  if (loggerState.isTestEnv) {
    return false;
  }

  if (process.env[UPDATE_CHECK_ENV] === 'true') {
    return false;
  }

  return process.env[UPDATE_CHECK_OPT_IN_ENV] === 'true';
};
