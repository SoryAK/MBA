// MBA CI pipeline — runs on every push to main (see docs/ci.md for job setup).
// Requires a NodeJS tool named 'node-22' configured in Jenkins (Manage Jenkins → Tools).
pipeline {
    agent any

    tools {
        nodejs 'node-22'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Typecheck') {
            steps {
                sh 'npm run typecheck'
            }
        }

        stage('Test') {
            steps {
                sh 'npm test'
            }
        }

        stage('Build') {
            steps {
                sh 'npm run build'
            }
        }
    }
}
