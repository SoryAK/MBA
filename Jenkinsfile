// MBA CI pipeline — local reference only. The merge gate is GitHub Actions
// (.github/workflows/ci.yml) plus the Protect main ruleset; see docs/ci.md.
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
