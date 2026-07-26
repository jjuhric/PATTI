const { broadcastAlert } = require('../routes/alerts');

class AiQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.activeTask = null;
    this.taskIdCounter = 0;
    this.enqueue = this.enqueue.bind(this);
    this.getState = this.getState.bind(this);
    this.broadcastState = this.broadcastState.bind(this);
    this.processNext = this.processNext.bind(this);
  }

  enqueue(taskFn, metadata = {}) {
    if (process.env.NODE_ENV === 'test') {
      return taskFn(() => {});
    }

    // Arbitration: the host always wins. A PATTI client's request never queues behind or
    // alongside host activity - it's rejected outright so the client can show a clear
    // "host is busy" message instead of waiting silently. A host request always jumps to
    // the front of the line, aborting an in-flight client task if one is running.
    const origin = metadata.origin === 'patti_client' ? 'patti_client' : 'host';

    if (origin === 'patti_client') {
      const hostActive = this.isProcessing && this.activeTask?.metadata?.origin === 'host';
      const hostQueued = this.queue.some(t => t.metadata.origin === 'host');
      if (hostActive || hostQueued) {
        const err = new Error('Host is currently busy. Please try again shortly.');
        err.code = 'HOST_BUSY';
        return Promise.reject(err);
      }
    }

    return new Promise((resolve, reject) => {
      const taskId = ++this.taskIdCounter;
      const task = {
        id: taskId,
        metadata: {
          nodeId: metadata.nodeId || 'unknown-node',
          name: metadata.name || 'AI Task',
          requestedAt: new Date().toISOString(),
          ...metadata,
          origin
        },
        taskFn,
        resolve,
        reject
      };

      if (origin === 'host') {
        // Reject any client tasks still waiting (never run them after a host request shows
        // up), and abort a client task that's actively generating right now.
        const remaining = [];
        for (const queuedTask of this.queue) {
          if (queuedTask.metadata.origin === 'patti_client') {
            const err = new Error('Host interrupted your request. Please try again later.');
            err.code = 'HOST_PREEMPTED';
            queuedTask.reject(err);
          } else {
            remaining.push(queuedTask);
          }
        }
        this.queue = remaining;
        this.queue.unshift(task);

        if (this.isProcessing && this.activeTask?.metadata?.origin === 'patti_client') {
          const abortController = this.activeTask.metadata.abortController;
          if (abortController) {
            try { abortController.abort(); } catch (e) { /* already aborted/settled */ }
          }
          const err = new Error('Host interrupted your request. Please try again later.');
          err.code = 'HOST_PREEMPTED';
          this.activeTask.reject(err);
        }
      } else {
        this.queue.push(task);
      }

      this.broadcastState();

      // Process next in queue
      this.processNext();
    });
  }

  getState() {
    return {
      isBusy: this.isProcessing,
      busyBy: this.activeTask ? (this.activeTask.metadata.origin || 'host') : null,
      activeTask: this.activeTask ? {
        id: this.activeTask.id,
        metadata: this.activeTask.metadata,
        startedAt: this.activeTask.startedAt
      } : null,
      queueLength: this.queue.length,
      waitingQueue: this.queue.map(t => ({
        id: t.id,
        metadata: t.metadata
      }))
    };
  }

  broadcastState(thoughtText = null, activeNode = null) {
    const state = this.getState();
    broadcastAlert({
      type: 'ai_state',
      isBusy: state.isBusy,
      busyBy: state.busyBy,
      activeTask: state.activeTask,
      queueLength: state.queueLength,
      waitingQueue: state.waitingQueue,
      thought: thoughtText || (this.activeTask ? `Executing task: ${this.activeTask.metadata.name}` : 'Idle'),
      activeNode: activeNode || (this.activeTask ? this.activeTask.metadata.nodeId : null),
      timestamp: new Date().toISOString()
    });
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    this.activeTask = this.queue.shift();
    this.activeTask.startedAt = new Date().toISOString();
    
    this.broadcastState(`Starting task: ${this.activeTask.metadata.name}`);

    try {
      const result = await this.activeTask.taskFn((thought) => {
        this.broadcastState(thought);
      });
      this.activeTask.resolve(result);
    } catch (err) {
      this.activeTask.reject(err);
    } finally {
      this.activeTask = null;
      this.isProcessing = false;
      this.broadcastState('Idle');
      
      this.processNext();
    }
  }
}

module.exports = new AiQueue();
