import * as execa from "execa";
import * as glob from "glob";
import * as path from "path";
import * as portfinder from "portfinder";
import { ConfigurationChangeEvent, ConfigurationTarget, Disposable, TextDocument, window, workspace, WorkspaceConfiguration } from "vscode";
import { LT_CHECK_PATH, LT_CONFIGURATION_ROOT, LT_DOCUMENT_LANGUAGE_IDS, LT_OUTPUT_CHANNEL, LT_PUBLIC_URL, LT_SERVICE_EXTERNAL, LT_SERVICE_MANAGED, LT_SERVICE_PARAMETERS, LT_SERVICE_PUBLIC } from "./constants";

export class ConfigurationManager implements Disposable {

  private static globalIgnoredWordsSection: string = "languageTool.ignoredWordsGlobal";
  private static workspaceIgnoredWordsSection: string = "languageTool.ignoredWordsInWorkspace";
  private static ignoredWordHintSection: string = "languageTool.ignoredWordHint";

  private config: WorkspaceConfiguration;
  private serviceUrl: string | undefined;
  private managedPort: number | undefined;
  private process: execa.ExecaChildProcess | undefined;
  private globallyIgnoredWords: Set<string>;
  private workspaceIgnoredWords: Set<string>;

  // Constructor

  constructor() {
    this.config = workspace.getConfiguration(LT_CONFIGURATION_ROOT);
    this.serviceUrl = this.findServiceUrl(this.getServiceType());
    this.startManagedService();
    this.globallyIgnoredWords = this.getGloballyIgnoredWords();
    this.workspaceIgnoredWords = this.getWorkspaceIgnoredWords();
  }

  // Public instance methods

  public dispose(): void {
    this.stopManagedService();
  }

  public reloadConfiguration(event: ConfigurationChangeEvent) {
    this.config = workspace.getConfiguration(LT_CONFIGURATION_ROOT);
    this.serviceUrl = this.findServiceUrl(this.getServiceType());
    // Changed service type
    if (event.affectsConfiguration("languageToolLinter.serviceType")) {
      switch (this.getServiceType()) {
        case LT_SERVICE_MANAGED:
          this.startManagedService();
          break;
        default:
          this.stopManagedService();
          break;
      }
    }
    // Changed class path for managed service
    if (this.getServiceType() === LT_SERVICE_MANAGED
      && (event.affectsConfiguration("languageToolLinter.managed.classPath")
        || event.affectsConfiguration("languageToolLinter.managed.jarFile"))) {
      this.startManagedService();
    }
    // Only allow preferred variants when language === auto
    if (event.affectsConfiguration("languageToolLinter.languageTool.preferredVariants")
      || event.affectsConfiguration("languageToolLinter.languageTool.language")) {
      if (this.config.get("languageTool.language") !== "auto"
        && this.config.get("languageTool.preferredVariants", "") !== "") {
        window.showErrorMessage("Cannot use preferred variants unless language is set to auto. Please review your configuration settings for LanguageTool.");
      }
    }
    this.globallyIgnoredWords = this.getGloballyIgnoredWords();
    this.workspaceIgnoredWords = this.getWorkspaceIgnoredWords();
  }

  // Smart Format on Type
  public isSmartFormatOnType(): boolean {
    return this.config.get("smartFormat.onType") as boolean;
  }

  // Smart Format on Save
  public isSmartFormatOnSave(): boolean {
    return this.config.get("smartFormat.onSave") as boolean;
  }

  // Is Language ID Supported?
  public isSupportedDocument(document: TextDocument): boolean {
    if (document.uri.scheme === "file") {
      return (LT_DOCUMENT_LANGUAGE_IDS.indexOf(document.languageId) > -1);
    }
    return false;
  }

  public getServiceType(): string {
    return this.get("serviceType") as string;
  }

  public getServiceParameters(): Map<string, string> {
    const config: WorkspaceConfiguration = this.config;
    const parameters: Map<string, string> = new Map();
    LT_SERVICE_PARAMETERS.forEach((ltKey) => {
      const configKey: string = "languageTool." + ltKey;
      const value: string | undefined = config.get(configKey);
      if (value) {
        parameters.set(ltKey, value);
      }
    });
    return parameters;
  }

  public getUrl(): string | undefined {
    return this.serviceUrl;
  }

  public getLintOnChange(): boolean {
    return this.config.get("lintOnChange") as boolean;
  }

  public getClassPath(): string {
    const jarFile: string = this.get("managed.jarFile") as string;
    const classPath: string = this.get("managed.classPath") as string;
    const classPathFiles: string[] = [];
    // DEPRECATED
    if (jarFile !== "") {
      window.showWarningMessage('"LanguageTool Linter > Managed: Jar File" is deprecated. Please use "LanguageTool > Managed: Class Path" instead.');
      classPathFiles.push(jarFile);
    }
    if (classPath !== "") {
      classPath.split(path.delimiter).forEach((globPattern: string) => {
        glob.sync(globPattern).forEach((match: string) => {
          classPathFiles.push(match);
        });
      });
    }
    const classPathString: string = classPathFiles.join(path.delimiter);
    return classPathString;
  }

  // Stop the managed service
  public stopManagedService(): void {
    if (this.process) {
      LT_OUTPUT_CHANNEL.appendLine("Closing managed service server.");
      this.process.cancel();
      this.process = undefined;
    }
  }

  // Manage Ignored Words Lists
  public isIgnoredWord(word: string): boolean {
    return this.isGloballyIgnoredWord(word) || this.isWorkspaceIgnoredWord(word);
  }

  // Is word ignored at the User Level?
  public isGloballyIgnoredWord(word: string): boolean {
    return this.globallyIgnoredWords.has(word.toLowerCase());
  }

  // Is word ignored at the Workspace Level?
  public isWorkspaceIgnoredWord(word: string): boolean {
    return this.workspaceIgnoredWords.has(word.toLowerCase());
  }

  // Add word to User Level ignored word list.
  public ignoreWordGlobally(word: string): void {
    const lowerCaseWord: string = word.toLowerCase();
    if (!this.isGloballyIgnoredWord(lowerCaseWord)) {
      this.globallyIgnoredWords.add(lowerCaseWord);
      this.saveGloballyIgnoredWords();
    }
  }

  // Add word to Workspace Level ignored word list.
  public ignoreWordInWorkspace(word: string): void {
    const lowerCaseWord: string = word.toLowerCase();
    if (!this.isWorkspaceIgnoredWord(lowerCaseWord)) {
      this.workspaceIgnoredWords.add(lowerCaseWord);
      this.saveWorkspaceIgnoredWords();
    }
  }

  // Remove word from User Level ignored word list.
  public removeGloballyIgnoredWord(word: string): void {
    const lowerCaseWord: string = word.toLowerCase();
    if (this.isGloballyIgnoredWord(lowerCaseWord)) {
      this.globallyIgnoredWords.delete(lowerCaseWord);
      this.saveGloballyIgnoredWords();
    }
  }

  // Remove word from Workspace Level ignored word list.
  public removeWorkspaceIgnoredWord(word: string): void {
    const lowerCaseWord: string = word.toLowerCase();
    if (this.isWorkspaceIgnoredWord(lowerCaseWord)) {
      this.workspaceIgnoredWords.delete(lowerCaseWord);
      this.saveWorkspaceIgnoredWords();
    }
  }

  // Show hints for ignored words?
  public showIgnoredWordHints(): boolean {
    return this.config.get(ConfigurationManager.ignoredWordHintSection) as boolean;
  }

  // Private instance methods

  private findServiceUrl(serviceType: string): string | undefined {
    switch (serviceType) {
      case LT_SERVICE_EXTERNAL:
        return this.getExternalUrl() + LT_CHECK_PATH;
      case LT_SERVICE_MANAGED:
        const port = this.getManagedServicePort();
        if (port) {
          return "http://localhost:" + this.getManagedServicePort() + LT_CHECK_PATH;
        } else {
          return undefined;
        }
      case LT_SERVICE_PUBLIC:
        return LT_PUBLIC_URL + LT_CHECK_PATH;
      default:
        return undefined;
    }
  }

  private setManagedServicePort(port: number): void {
    this.managedPort = port;
  }

  private getManagedServicePort(): number | undefined {
    return this.managedPort;
  }

  private getExternalUrl(): string | undefined {
    return this.get("external.url");
  }

  private get(key: string): string | undefined {
    return this.config.get(key);
  }

  private startManagedService(): void {
    if (this.getServiceType() === LT_SERVICE_MANAGED) {
      const classpath: string = this.getClassPath();
      this.stopManagedService();
      portfinder.getPort({ host: "127.0.0.1" }, (error: any, port: number) => {
        if (error) {
          LT_OUTPUT_CHANNEL.appendLine("Error getting open port: " + error.message);
          LT_OUTPUT_CHANNEL.show(true);
        } else {
          this.setManagedServicePort(port);
          const args: string[] = [
            "-cp",
            classpath,
            "org.languagetool.server.HTTPServer",
            "--port",
            port.toString(),
          ];
          LT_OUTPUT_CHANNEL.appendLine("Starting managed service.");
          (this.process = execa("java", args)).catch((err: any) => {
            if (err.isCanceled) {
              LT_OUTPUT_CHANNEL.appendLine("Managed service process stopped.");
            } else if (err.failed) {
              LT_OUTPUT_CHANNEL.appendLine("Managed service command failed: " + err.command);
              LT_OUTPUT_CHANNEL.appendLine("Error Message: " + err.message);
              LT_OUTPUT_CHANNEL.show(true);
            }
          });
          this.process.stderr.addListener("data", (data: any) => {
            LT_OUTPUT_CHANNEL.appendLine(data);
            LT_OUTPUT_CHANNEL.show(true);
          });
          this.process.stdout.addListener("data", (data: any) => {
            LT_OUTPUT_CHANNEL.appendLine(data);
          });
          this.serviceUrl = this.findServiceUrl(this.getServiceType());
        }
      });
    }
  }

  // Save words to settings
  private saveIgnoredWords(words: Set<string>, section: string, configurationTarget: ConfigurationTarget): void {
    const wordArray: string[] = Array.from(words).sort();
    this.config.update(section, wordArray, configurationTarget);
  }

  // Get Globally ingored words from settings.
  private getGloballyIgnoredWords(): Set<string> {
    return new Set<string>(this.config.get<string[]>(ConfigurationManager.globalIgnoredWordsSection));
  }

  // Save word to User Level ignored word list.
  private saveGloballyIgnoredWords(): void {
    this.saveIgnoredWords(this.globallyIgnoredWords, ConfigurationManager.globalIgnoredWordsSection, ConfigurationTarget.Global);
  }

  // Get Workspace ignored words from settings.
  private getWorkspaceIgnoredWords(): Set<string> {
    return new Set<string>(this.config.get<string[]>(ConfigurationManager.workspaceIgnoredWordsSection));
  }

  // Save word to Workspace Level ignored word list.
  private saveWorkspaceIgnoredWords(): void {
    this.saveIgnoredWords(this.workspaceIgnoredWords, ConfigurationManager.workspaceIgnoredWordsSection, ConfigurationTarget.Workspace);
  }

}
