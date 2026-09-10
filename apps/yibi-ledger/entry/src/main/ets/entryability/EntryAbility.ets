import { ConfigurationConstant, UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';

const LOG_DOMAIN: number = 0x0000;
const LOG_TAG: string = 'YibiLedger';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.loadContent('pages/Index', (error: BusinessError) => {
      if (error.code) {
        hilog.error(LOG_DOMAIN, LOG_TAG,
          'Unable to load main page. Code: %{public}d, message: %{public}s',
          error.code, error.message);
        return;
      }
      // The first version has one light palette. Apply it after the page loads,
      // as required by ApplicationContext.setColorMode.
      try {
        this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT);
      } catch (cause) {
        const colorError = cause as BusinessError;
        hilog.error(LOG_DOMAIN, LOG_TAG,
          'Unable to apply light theme. Code: %{public}d, message: %{public}s',
          colorError.code, colorError.message);
      }
    });
  }
}
