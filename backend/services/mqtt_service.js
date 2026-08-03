const mqtt = require('mqtt');
const logger = require('../utils/logger');

class MqttService {
  constructor() {
    this.client = null;
    this.nodeId = process.env.MQTT_NODE_ID || 'windows-main';
    this.brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    this.connected = false;
    this.subscriptions = new Map(); // topic -> Set of callbacks
    this.heartbeatInterval = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
  }

  init() {
    if (this.client) {
      return;
    }

    const options = {
      clientId: this.nodeId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
    };

    if (process.env.MQTT_USERNAME) {
      options.username = process.env.MQTT_USERNAME;
    }
    if (process.env.MQTT_PASSWORD) {
      options.password = process.env.MQTT_PASSWORD;
    }

    logger.info(`[MQTT] Connecting to broker at ${this.brokerUrl} as client "${this.nodeId}"`);
    
    // Add helpful warning for field nodes trying to connect to localhost
    if ((this.brokerUrl.includes('localhost') || this.brokerUrl.includes('127.0.0.1')) && (this.nodeId.includes('field') || this.nodeId.includes('rpi'))) {
      logger.warn('[MQTT] Warning: You are running on a field node but your MQTT_BROKER_URL points to localhost. If your broker runs on the main host, you need to change MQTT_BROKER_URL in your .env file to point to the main host\'s IP address.');
    }

    this.client = mqtt.connect(this.brokerUrl, options);

    this.client.on('connect', () => {
      this.connected = true;
      logger.info(`[MQTT] Connected to broker successfully.`);
      
      // Subscribe to alerts topic
      this.subscribe('private_ai/alerts', (payload) => {
        try {
          const { broadcastAlert } = require('../routes/alerts');
          broadcastAlert(payload);
        } catch (err) {
          logger.error('[MQTT] Failed to broadcast alert from MQTT payload:', err);
        }
      });
      
      // Subscribe to edge node responses wildcard
      this.subscribe('nodes/+/responses', (payload) => {
        if (payload && payload.requestId && this.pendingRequests.has(payload.requestId)) {
          const { resolve, reject, timeout } = this.pendingRequests.get(payload.requestId);
          clearTimeout(timeout);
          this.pendingRequests.delete(payload.requestId);
          resolve(payload);
        }
      });

      // Resubscribe to all active subscriptions on reconnect
      for (const topic of this.subscriptions.keys()) {
        this.client.subscribe(topic, (err) => {
          if (err) {
            logger.error(`[MQTT] Failed to resubscribe to topic ${topic}: ${err.message}`);
          } else {
            logger.info(`[MQTT] Resubscribed to topic: ${topic}`);
          }
        });
      }

      // Start status heartbeat
      this.startHeartbeat();
    });

    this.client.on('message', (topic, message) => {
      const payloadString = message.toString();
      logger.debug(`[MQTT] Received message on topic "${topic}": ${payloadString}`);
      
      // Handle subscriptions (both direct topic match and wildcard matching if needed)
      // Let's implement simple direct or wildcard topic routing
      for (const [registeredTopic, callbacks] of this.subscriptions.entries()) {
        if (this.topicMatches(registeredTopic, topic)) {
          let parsedPayload = payloadString;
          try {
            parsedPayload = JSON.parse(payloadString);
          } catch (e) {
            // Keep as string if not JSON
          }
          for (const callback of callbacks) {
            try {
              callback(parsedPayload, topic);
            } catch (err) {
              logger.error(`[MQTT] Error in message callback for topic "${topic}":`, err);
            }
          }
        }
      }
    });

    this.client.on('error', (err) => {
      const errMsg = err ? (err.message || err.code || JSON.stringify(err)) : 'Unknown error';
      logger.error(`[MQTT] Connection error: ${errMsg}`);
    });

    this.client.on('close', () => {
      if (this.connected) {
        this.connected = false;
        logger.warn(`[MQTT] Connection lost to broker.`);
        this.stopHeartbeat();
      }
    });
  }

  topicMatches(pattern, topic) {
    if (pattern === topic) return true;
    
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');
    
    if (patternParts.length > topicParts.length && patternParts[patternParts.length - 1] !== '#') {
      return false;
    }
    
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') {
        return true;
      }
      if (patternParts[i] === '+') {
        continue;
      }
      if (patternParts[i] !== topicParts[i]) {
        return false;
      }
    }
    
    return patternParts.length === topicParts.length;
  }

  subscribe(topic, callback) {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
      if (this.client && this.connected) {
        this.client.subscribe(topic, (err) => {
          if (err) {
            logger.error(`[MQTT] Failed to subscribe to topic ${topic}: ${err.message}`);
          } else {
            logger.info(`[MQTT] Subscribed to topic: ${topic}`);
          }
        });
      }
    }
    this.subscriptions.get(topic).add(callback);
    return () => this.unsubscribe(topic, callback);
  }

  unsubscribe(topic, callback) {
    if (this.subscriptions.has(topic)) {
      const callbacks = this.subscriptions.get(topic);
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscriptions.delete(topic);
        if (this.client && this.connected) {
          this.client.unsubscribe(topic, (err) => {
            if (err) {
              logger.error(`[MQTT] Failed to unsubscribe from topic ${topic}: ${err.message}`);
            } else {
              logger.info(`[MQTT] Unsubscribed from topic: ${topic}`);
            }
          });
        }
      }
    }
  }

  publish(topic, message, options = {}) {
    if (!this.client || !this.connected) {
      logger.warn(`[MQTT] Cannot publish to "${topic}". Client not connected.`);
      return false;
    }
    
    const payload = typeof message === 'object' ? JSON.stringify(message) : String(message);
    this.client.publish(topic, payload, options, (err) => {
      if (err) {
        logger.error(`[MQTT] Publish error on topic "${topic}": ${err.message}`);
      }
    });
    return true;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.publishStatus('online');
    
    this.heartbeatInterval = setInterval(() => {
      this.publishStatus('online');
    }, 30000); // Heartbeat every 30 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  publishStatus(status) {
    const topic = `private_ai/nodes/${this.nodeId}/status`;
    const payload = {
      nodeId: this.nodeId,
      status: status,
      timestamp: new Date().toISOString()
    };
    this.publish(topic, payload, { retain: true });
  }

  async publishAndAwaitResponse(nodeId, command, timeoutMs = 8000, extraPayload = {}) {
    const crypto = require('crypto');
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`MQTT Request Timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      const topic = `nodes/${nodeId}/commands`;
      const payload = {
        ...extraPayload,
        command,
        requestId
      };

      const success = this.publish(topic, payload);
      if (!success) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(new Error('Failed to publish command to MQTT broker.'));
      }
    });
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.client) {
      this.publishStatus('offline');
      this.client.end();
      this.client = null;
      this.connected = false;
      logger.info(`[MQTT] Client disconnected.`);
    }
  }
}

// Export singleton instance
module.exports = new MqttService();
