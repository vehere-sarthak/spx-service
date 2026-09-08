class ProcessEvents {
  public attach(): void {
    process.on('uncaughtException', (exception) => {
      console.log('uncaughtException', exception.stack);
    });

    process.on('unhandledRejection', (reason) => {
      console.log('unhandledRejection', reason);
    });

    process.on('warning', (warning) => {
      console.log('warning', warning.stack);
    });
  }
}

export default new ProcessEvents();
